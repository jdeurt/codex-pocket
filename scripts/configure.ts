import { type Thread, string } from "../src/lib/protocol";
import { saveSetupEnvironment, setupOrigin } from "./setup-env";
import { CodexRpc } from "../src/server/rpc";
import { configSchema } from "../src/server/config";
import { homedir } from "node:os";
import nextEnv from "@next/env";
import path from "node:path";
import { pocketInstructions } from "../src/server/pocket-runtime";
import { seedThread } from "./seed-thread";

// Codex injects its own thread ID into agent shells. Pocket selects its thread explicitly.
delete process.env.CODEX_THREAD_ID;
nextEnv.loadEnvConfig(process.cwd());
const origin = setupOrigin(process.env.POCKET_ORIGIN ?? "");
const requestedThreadId = process.env.POCKET_THREAD_ID ?? process.env.CODEX_THREAD_ID;
const envPath = path.resolve(".env.local");

const serverArgs: unknown = JSON.parse(process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]');
const config = configSchema.parse({
  threadId: requestedThreadId?.length ? requestedThreadId : "setup",
  cwd: process.env.CODEX_CWD ?? path.join(homedir(), "Developer"),
  codexBinary: process.env.CODEX_BINARY ?? "codex",
  serverArgs,
});

async function saveEnvironment(threadId: string) {
  const origins = new Set(
    (process.env.CODEX_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",")
  );

  if (origin) {
    origins.add(origin);
  }

  const values = {
    POCKET_PORT: process.env.POCKET_PORT ?? "3000",
    CODEX_THREAD_ID: threadId,
    CODEX_CWD: config.cwd,
    CODEX_BINARY: config.codexBinary,
    CODEX_ACTIVE_MESSAGE_MODE: process.env.CODEX_ACTIVE_MESSAGE_MODE ?? "steer",
    CODEX_ALLOWED_ORIGINS: [...origins].join(","),
    CODEX_SERVER_ARGS: process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]',
  };

  await saveSetupEnvironment(envPath, values);
}

const rpc = new CodexRpc();

try {
  await rpc.connect(config);
  let threadId = requestedThreadId;

  if (threadId) {
    await rpc.request<{ thread: Thread }>("thread/read", { threadId });
    await saveEnvironment(threadId);
    console.info(`Reused thread ${threadId}. Saved ${envPath}.`);
  } else {
    const { config: effective } = await rpc.request<{ config: Record<string, unknown> }>("config/read", {
      includeLayers: false,
      cwd: config.cwd,
    });
    const started = await rpc.request<{
      thread: Thread;
      model: string;
      reasoningEffort: string;
      sandbox: unknown;
      approvalPolicy: unknown;
    }>("thread/start", {
      cwd: config.cwd,
      ephemeral: false,
      developerInstructions: pocketInstructions(
        string(effective.developer_instructions),
        effective.sandbox_mode === "danger-full-access"
      ),
    });
    const { thread } = started;
    console.info(
      JSON.stringify({
        model: started.model,
        reasoningEffort: started.reasoningEffort,
        sandbox: started.sandbox,
        approvalPolicy: started.approvalPolicy,
      })
    );
    threadId = thread.id;
    await rpc.request("thread/name/set", { threadId, name: "Pocket" });
    await saveEnvironment(threadId);
    console.info(`Created Pocket thread ${threadId}. Saved ${envPath}.`);
    await seedThread(
      rpc,
      threadId,
      "This is the dedicated Pocket conversation on this Mac. For setup only, reply exactly: Pocket is ready. Do not use tools or change any files."
    );
  }
} finally {
  rpc.close();
}
