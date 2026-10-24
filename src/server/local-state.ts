import { t as captureResult } from "try";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
Resolve Pocket's explicitly configured private state directory.
@returns Absolute private state directory for this process.
*/
export const localDirectory = () =>
  path.resolve(
    /* turbopackIgnore: true */ process.env.CODEX_POCKET_STATE_DIR ?? path.join(homedir(), ".pocket", "data")
  );

/**
Write JSON to a fresh private sibling file before atomic replacement.
@param file - Absolute destination inside its already-created private directory.
@param data - JSON-serializable state to replace.
*/
async function writeAtomic(file: string, data: unknown) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;

  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}

/**
Persist private JSON after creating its containing directory, then atomically replace the destination.
@param name - Relative state filename owned by Pocket.
@param data - JSON-serializable state whose schema belongs to its caller.
*/
export async function writeLocal(name: string, data: unknown) {
  const file = path.resolve(localDirectory(), name);

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeAtomic(file, data);
}

/**
Read and decode one private JSON file before its caller validates the persisted schema.
@param name - State filename resolved inside the configured private directory.
@returns Untrusted decoded JSON.
*/
async function readJSONFile(name: string): Promise<unknown> {
  const text = await readFile(/* turbopackIgnore: true */ path.resolve(localDirectory(), name), "utf8");

  return JSON.parse(text);
}

/**
Read private JSON, using the fallback only when the file is absent.
@param name - Private state filename to read.
@param fallback - Value returned for ENOENT; other filesystem and parse errors propagate.
@returns Untrusted decoded JSON for the owning persistence schema.
*/
export async function readLocal(name: string, fallback: unknown): Promise<unknown> {
  const completed = await captureResult(readJSONFile(name));

  if (completed.ok) {
    return completed.value;
  }

  const error = completed.error;

  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return fallback;
  }

  throw error;
}
