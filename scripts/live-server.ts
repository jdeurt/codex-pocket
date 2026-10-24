import { type Config, configSchema } from "../src/server/config";
import { CodexRpc } from "../src/server/rpc";
import { mkdir } from "node:fs/promises";
import nextEnv from "@next/env";
import { once } from "node:events";
import path from "node:path";
import { pocketInstructions } from "../src/server/pocket-runtime";
import { seedThread } from "./seed-thread";
import { spawn } from "node:child_process";
import { string } from "../src/lib/protocol";

/**
Creates and seeds the explicitly opted-in native test conversation.
@param rpc - Connected native test transport.
@param config - Read-only sandbox configuration scoped to the test project.
@returns Newly created test thread identity.
*/
async function startThread(rpc: CodexRpc, config: Config) {
  const { config: effective } = await rpc.request("config/read", { includeLayers: false, cwd: config.cwd });
  const started = await rpc.request("thread/start", {
    cwd: config.cwd,
    approvalPolicy: "on-request",
    sandbox: "read-only",
    ephemeral: false,
    developerInstructions: pocketInstructions(string(effective.developer_instructions)),
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

  return threadId;
}

/**
Owns the native bootstrap connection until the new test session is ready.
@param project - Fresh private working folder created for this invocation.
@returns Native test configuration and its newly seeded thread identity.
*/
async function createSession(project: string) {
  const config = configSchema.parse({
    threadId: "bootstrap",
    cwd: project,
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    serverArgs: ["app-server", "--listen", "stdio://", "-c", 'sandbox_mode="read-only"'],
  });
  const rpc = new CodexRpc();

  return (async () => {
    await rpc.connect(config);

    return { config, threadId: await startThread(rpc, config) };
  })().finally(() => {
    rpc.close();
  });
}

/**
Runs the live browser host with signal handlers scoped to its child-process lifetime.
@param directory - Private state root for this invocation.
@param config - Native sandbox and working-folder configuration.
@param threadId - Explicitly created live test conversation.
@returns Completion when the browser host exits; spawn errors reject.
*/
async function hostSession(directory: string, config: Config, threadId: string) {
  const host = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CODEX_THREAD_ID: threadId,
        CODEX_CWD: config.cwd,
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

  await (async () => once(host, "exit"))().finally(() => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  });
}

/**
Archives the live test conversation using a separate bounded native connection.
@param config - Native sandbox configuration for this invocation.
@param threadId - Completed live test conversation to archive.
@returns Completion of archive acknowledgement and native transport cleanup.
*/
async function archiveSession(config: Config, threadId: string) {
  const cleanup = new CodexRpc();

  await (async () => {
    await cleanup.connect(config);
    await cleanup.request("thread/archive", { threadId });
  })().finally(() => {
    cleanup.close();
  });
}

/**
Coordinates session creation, browser-host exit and archival for the live check.
@param directory - Private state root for this invocation.
@param project - Fresh private working folder.
@returns Completion of the live test host and native archival.
*/
async function serveSession(directory: string, project: string) {
  const { config, threadId } = await createSession(project);

  await hostSession(directory, config, threadId);
  await archiveSession(config, threadId);
}

/**
Creates isolated live-check directories after dotenv settings are loaded.
@returns Completion of the explicitly selected live server lifecycle.
*/
async function liveServer() {
  const directory = path.resolve(".local", "live-check", crypto.randomUUID());
  const project = path.join(directory, "project");

  process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "bridge");
  await mkdir(project, { recursive: true });
  await serveSession(directory, project);
}

nextEnv.loadEnvConfig(process.cwd());
await liveServer();
