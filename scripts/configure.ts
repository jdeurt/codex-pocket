import { saveSetupEnvironment, setupOrigin } from "./setup-env";
import { CodexRpc } from "../src/server/rpc";
import { configSchema } from "../src/server/config";
import { homedir } from "node:os";
import nextEnv from "@next/env";
import path from "node:path";
import { pocketInstructions } from "../src/server/pocket-runtime";
import { seedThread } from "./seed-thread";
import { string } from "../src/lib/protocol";

/**
Configures one explicit Pocket thread and closes the native setup connection.
@returns Completion of thread reuse or creation and private environment persistence.
*/
async function setup() {
  const origin = setupOrigin(process.env.POCKET_ORIGIN ?? "");
  const requestedThreadId = process.env.POCKET_THREAD_ID ?? process.env.CODEX_THREAD_ID;
  const envPath = path.resolve(".env.local");

  const serverArgs: unknown = JSON.parse(process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]');
  const config = configSchema.parse({
    threadId: requestedThreadId?.length ? requestedThreadId : "setup",
    cwd: process.env.CODEX_CWD ?? path.join(homedir(), ".pocket", "workspace"),
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

    await saveSetupEnvironment(envPath, {
      POCKET_PORT: process.env.POCKET_PORT ?? "3000",
      CODEX_THREAD_ID: threadId,
      CODEX_CWD: config.cwd,
      CODEX_BINARY: config.codexBinary,
      CODEX_ACTIVE_MESSAGE_MODE: process.env.CODEX_ACTIVE_MESSAGE_MODE ?? "steer",
      CODEX_ALLOWED_ORIGINS: [...origins].join(","),
      CODEX_SERVER_ARGS: process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]',
    });
  }

  async function createThread(rpc: CodexRpc) {
    const { config: effective } = await rpc.request("config/read", {
      includeLayers: false,
      cwd: config.cwd,
    });
    const started = await rpc.request("thread/start", {
      cwd: config.cwd,
      ephemeral: false,
      developerInstructions: pocketInstructions(string(effective.developer_instructions)),
    });
    const { thread } = started;
    const threadId = thread.id;

    console.info(
      JSON.stringify({
        model: started.model,
        reasoningEffort: started.reasoningEffort,
        sandbox: started.sandbox,
        approvalPolicy: started.approvalPolicy,
      })
    );

    await rpc.request("thread/name/set", { threadId, name: "Pocket" });
    await saveEnvironment(threadId);
    console.info(`Created Pocket thread ${threadId}. Saved ${envPath}.`);
    await seedThread(
      rpc,
      threadId,
      "This is the dedicated Pocket conversation on this Mac. For setup only, reply exactly: Pocket is ready. Do not use tools or change any files."
    );
  }

  async function configure(rpc: CodexRpc) {
    await rpc.connect(config);

    if (requestedThreadId) {
      await rpc.request("thread/read", { threadId: requestedThreadId });
      await saveEnvironment(requestedThreadId);
      console.info(`Reused thread ${requestedThreadId}. Saved ${envPath}.`);
    } else {
      await createThread(rpc);
    }
  }

  const rpc = new CodexRpc();

  await configure(rpc).finally(() => {
    rpc.close();
  });
}

// Codex injects its own thread ID into agent shells. Pocket selects its thread explicitly.
delete process.env.CODEX_THREAD_ID;

// A running Next service passes its environment-loaded flag to child processes.
nextEnv.loadEnvConfig(process.cwd(), undefined, undefined, true);

await setup();
