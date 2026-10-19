import { localDirectory, writeLocal } from "./local-state";
import { readFile, readdir, rm } from "node:fs/promises";
import type { CodexRpc } from "./rpc";
import type { Snapshot } from "../lib/protocol";
import path from "node:path";

export async function resolveDesktopReplies(snapshot: Snapshot, rpc: CodexRpc | undefined, publish: () => void) {
  let names: string[];

  try {
    names = await readdir(localDirectory());
  } catch {
    return;
  }

  for (const name of names) {
    if (!/^reply-[a-f0-9-]+\.json$/.test(name)) {
      continue;
    }

    const file = path.resolve(localDirectory(), name);
    const reply = JSON.parse(await readFile(file, "utf8")) as { id: string | number; result: unknown };
    const request = snapshot.requests.find((r) => r.id === reply.id);

    if (request && rpc?.running) {
      rpc.respond(request.id, reply.result);
      snapshot.requests = snapshot.requests.filter((r) => r.id !== request.id);
      await writeLocal("requests.json", snapshot.requests);
      publish();
    }

    await rm(file);
  }
}
