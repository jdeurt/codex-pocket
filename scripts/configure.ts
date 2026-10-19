import { chmod, readFile, writeFile } from "node:fs/promises";
import { CodexRpc } from "../src/server/rpc";
import type { Thread } from "../src/lib/protocol";
import { configSchema } from "../src/server/config";
import { homedir } from "node:os";
import nextEnv from "@next/env";
import path from "node:path";
import { seedThread } from "./seed-thread";

// Codex injects its own thread ID into agent shells. Pocket selects its thread explicitly.
delete process.env.CODEX_THREAD_ID;
nextEnv.loadEnvConfig(process.cwd());
const requestedOrigin = process.env.POCKET_ORIGIN;

if (
  !requestedOrigin ||
  new URL(requestedOrigin).protocol !== "https:" ||
  new URL(requestedOrigin).origin !== requestedOrigin
) {
  throw new Error("Set POCKET_ORIGIN to this computer's Tailscale HTTPS origin, without a trailing slash.");
}

const origin: string = requestedOrigin;
const requestedThreadId = process.env.POCKET_THREAD_ID ?? process.env.CODEX_THREAD_ID;
const envPath = path.resolve(".env.local");
const PRIVATE_FILE_MODE = 0o600;

const config = configSchema.parse({
  threadId: requestedThreadId || "setup",
  cwd: process.env.CODEX_CWD ?? path.join(homedir(), "Developer"),
  codexBinary: process.env.CODEX_BINARY ?? "codex",
  serverArgs: JSON.parse(process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]'),
});

function quoteEnvironment(value: string) {
  const delimiter = ["'", "`", '"'].find((candidate) => !value.includes(candidate));

  if (!delimiter) {
    throw new Error("Environment value contains unsupported quote characters.");
  }

  return `${delimiter}${value.replaceAll("$", String.raw`\$`)}${delimiter}`;
}

async function saveEnvironment(threadId: string) {
  let source = "";

  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const origins = new Set(
    (process.env.CODEX_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",")
  );
  origins.add(origin);
  const values = {
    CODEX_THREAD_ID: threadId,
    CODEX_CWD: config.cwd,
    CODEX_BINARY: config.codexBinary,
    CODEX_ACTIVE_MESSAGE_MODE: process.env.CODEX_ACTIVE_MESSAGE_MODE ?? "steer",
    CODEX_ALLOWED_ORIGINS: [...origins].join(","),
    CODEX_SERVER_ARGS: process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]',
  };

  for (const [key, value] of Object.entries(values)) {
    const entry = `${key}=${quoteEnvironment(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    source = pattern.test(source) ? source.replace(pattern, () => entry) : `${source.trimEnd()}\n${entry}\n`;
  }

  await writeFile(envPath, source.trimStart(), { mode: PRIVATE_FILE_MODE });
  await chmod(envPath, PRIVATE_FILE_MODE);
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
    const started = await rpc.request<{
      thread: Thread;
      model: string;
      reasoningEffort: string;
      sandbox: unknown;
      approvalPolicy: unknown;
    }>("thread/start", { cwd: config.cwd, ephemeral: false });
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
