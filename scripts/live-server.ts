import { CodexRpc } from "../src/server/rpc";
import { configSchema } from "../src/server/config";
import { mkdir } from "node:fs/promises";
import nextEnv from "@next/env";
import path from "node:path";
import { pocketInstructions } from "../src/server/pocket-runtime";
import { seedThread } from "./seed-thread";
import { spawn } from "node:child_process";
import { string } from "../src/lib/protocol";

nextEnv.loadEnvConfig(process.cwd());
const directory = path.resolve(".local", "live-check", crypto.randomUUID());
const project = path.join(directory, "project");
process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "bridge");
await mkdir(project, { recursive: true });
const config = configSchema.parse({
  threadId: "bootstrap",
  cwd: project,
  codexBinary: process.env.CODEX_BINARY ?? "codex",
  serverArgs: ["app-server", "--listen", "stdio://", "-c", 'sandbox_mode="read-only"'],
});
const rpc = new CodexRpc();
await rpc.connect(config);
const { config: effective } = await rpc.request("config/read", {
  includeLayers: false,
  cwd: config.cwd,
});
const started = await rpc.request("thread/start", {
  cwd: project,
  approvalPolicy: "on-request",
  sandbox: "read-only",
  ephemeral: false,
  developerInstructions: pocketInstructions(string(effective.developer_instructions), false),
});
const threadId = started.thread.id;
await rpc.request("thread/name/set", { threadId, name: "Pocket live integration check" });

await seedThread(rpc, threadId, "Integration check. Reply exactly READY. Do not use tools.", {
  ...(process.env.CODEX_TEST_PLAN_MODE === "1" && {
    collaborationMode: {
      mode: "plan",
      settings: { model: started.model, reasoning_effort: started.reasoningEffort },
    },
  }),
});
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
      CODEX_SERVER_ARGS: JSON.stringify(config.serverArgs),
    },
  }
);
const stop = () => {
  host.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise<void>((resolve) =>
  host.once("exit", () => {
    resolve();
  })
);
const cleanup = new CodexRpc();

try {
  await cleanup.connect(config);
  await cleanup.request("thread/archive", { threadId });
} finally {
  cleanup.close();
}
