import { readFile, rename, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { z } from "zod";

const directory = ".local/agent-browser-replay";

/**
Atomically advances the private native replay without exposing a partial control file.
@param stage - Named replay stage consumed by the fake RPC child.
@returns Completion of the control-file replacement.
*/
export async function control(stage: string) {
  await writeFile(`${directory}/control.tmp`, JSON.stringify({ stage }));
  await rename(`${directory}/control.tmp`, `${directory}/control.json`);
}

/**
Reads the replay's persisted managed-child identities at the fixture boundary.
@returns Validated title-to-native-identity mapping.
*/
export async function readAgentIds() {
  return z.record(z.string(), z.string()).parse(JSON.parse(await readFile(`${directory}/ids.json`, "utf8")));
}

/**
Updates private SQLite fixture lifecycle state before discovery assertions.
@param isSettled - Whether both active managed children have reached their idle fixture state.
@returns Completion of the existing status/request updates.
*/
export async function lifecycle(isSettled = false) {
  const entries = await readAgentIds();
  const db = new Database(`${directory}/state/delegations.sqlite`);

  db.prepare("UPDATE side_pockets SET status=? WHERE id=?").run(
    isSettled ? "idle" : "waiting",
    entries["Codex Side Pocket"]
  );
  db.prepare("UPDATE side_pockets SET status=? WHERE id=?").run(
    isSettled ? "idle" : "running",
    entries["Claude Side Pocket"]
  );
  db.prepare("UPDATE delegation_requests SET status='pending' WHERE childId=?").run(entries["Codex Side Pocket"]);
  db.close();
}
