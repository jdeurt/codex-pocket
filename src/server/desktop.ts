import { localDirectory, writeLocal } from "./local-state";
import { readFile, readdir, rm } from "node:fs/promises";
import { type CodexRpc } from "./rpc";
import { type Snapshot } from "../lib/protocol";
import path from "node:path";
import { requestFile } from "./request-files";
import { z } from "zod";
import { t as attempt } from "try";

const replySchema = z.object({
  threadId: z.string().optional(),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
});

/**
Apply one validated desktop answer to its still-pending native request, then remove the reply file.
@param file - Private reply file selected by the filename allowlist.
@param snapshot - Current request state updated only after native response dispatch.
@param rpc - Existing native client, absent while disconnected.
@param publish - Snapshot publisher called after the answer is persisted.
*/
async function resolveReply(file: string, snapshot: Snapshot, rpc: CodexRpc | undefined, publish: () => void) {
  const reply = replySchema.parse(JSON.parse(await readFile(file, "utf8")));
  const request =
    (reply.threadId ?? process.env.CODEX_THREAD_ID) === snapshot.threadId
      ? snapshot.requests.find((r) => r.id === reply.id)
      : undefined;

  if (request && rpc?.running) {
    rpc.respond(request.id, reply.result);
    snapshot.requests = snapshot.requests.filter((r) => r.id !== request.id);
    await writeLocal(requestFile(snapshot.threadId), snapshot.requests);
    publish();
  }

  if (request) {
    await rm(file);
  }
}

/**
Apply allowlisted private desktop reply files to pending native requests.
@param snapshot - Current request state updated after accepted answers.
@param rpc - Connected native client, when available.
@param publish - Publisher called after an accepted reply is persisted.
*/
export async function resolveDesktopReplies(snapshot: Snapshot, rpc: CodexRpc | undefined, publish: () => void) {
  const outcome = await attempt(() => readdir(localDirectory()));

  if (!outcome.ok) {
    return;
  }

  for (const name of outcome.value) {
    if (!/^reply-[a-f0-9-]+\.json$/.test(name)) {
      continue;
    }

    const filename = path.resolve(localDirectory(), name);
    const completed = await attempt(resolveReply, filename, snapshot, rpc, publish);

    if (completed.ok) {
      continue;
    }

    const error = completed.error;

    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/** Poll desktop input without rejecting the host timer callback.
@param args - Parent projection, transport and publication callback.
*/
export async function pollDesktopReplies(...args: Parameters<typeof resolveDesktopReplies>) {
  const result = await attempt(resolveDesktopReplies, ...args);

  if (!result.ok) {
    console.error(result.error);
  }
}
