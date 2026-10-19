import { type RpcEvent, type Thread, object } from "../src/lib/protocol";
import { CodexRpc } from "../src/server/rpc";
import { configSchema } from "../src/server/config";
import { mkdir } from "node:fs/promises";
import nextEnv from "@next/env";
import path from "node:path";
import { spawn } from "node:child_process";

const TURN_TIMEOUT_MS = 120_000;
nextEnv.loadEnvConfig(process.cwd());
const directory = path.resolve(".local", "live-check", crypto.randomUUID());
const project = path.join(directory, "project");
await mkdir(project, { recursive: true });
const config = configSchema.parse({
  threadId: "bootstrap",
  cwd: project,
  codexBinary: process.env.CODEX_BINARY ?? "codex",
});
const rpc = new CodexRpc();
await rpc.connect(config);
const started = await rpc.request<{ thread: Thread; model: string; reasoningEffort: string | null }>("thread/start", {
  cwd: project,
  approvalPolicy: "on-request",
  sandbox: "read-only",
  ephemeral: false,
});
const threadId = started.thread.id;
await rpc.request("thread/name/set", { threadId, name: "Pocket live integration check" });

async function seed() {
  const completion = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => completion.reject(new Error("Codex seed turn timed out.")), TURN_TIMEOUT_MS);
  const listener = (event: RpcEvent) => {
    if (event.method !== "turn/completed" || event.params.threadId !== threadId) {
      return;
    }

    const turn = object(event.params.turn);

    if (turn.status === "completed") {
      completion.resolve(true);
    } else {
      completion.reject(new Error(`Codex seed failed: ${JSON.stringify(turn.error)}`));
    }
  };
  rpc.on("event", listener);

  try {
    await rpc.request("turn/start", {
      threadId,
      ...(process.env.CODEX_TEST_PLAN_MODE === "1" && {
        collaborationMode: {
          mode: "plan",
          settings: { model: started.model, reasoning_effort: started.reasoningEffort },
        },
      }),
      input: [{ type: "text", text: "Integration check. Reply exactly READY. Do not use tools.", text_elements: [] }],
    });
    await completion.promise;
  } finally {
    clearTimeout(timer);
    rpc.off("event", listener);
  }
}

await seed();
rpc.close();

const host = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_THREAD_ID: threadId,
      CODEX_CWD: project,
      CODEX_POCKET_STATE_DIR: path.join(directory, "bridge"),
      CODEX_ALLOWED_ORIGINS: "http://127.0.0.1:3101",
      CODEX_ACTIVE_MESSAGE_MODE: process.env.CODEX_TEST_ACTIVE_MODE ?? "steer",
      CODEX_SERVER_ARGS: '["app-server","--listen","stdio://"]',
    },
  }
);
const stop = () => {
  host.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise<void>((resolve) => host.once("exit", () => resolve()));
const cleanup = new CodexRpc();

try {
  await cleanup.connect(config);
  await cleanup.request("thread/archive", { threadId });
} finally {
  cleanup.close();
}
