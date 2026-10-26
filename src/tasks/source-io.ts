import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { t } from "try";
import { valueAfterCleanup } from "../lib/results";

/** Install a fully written exact original without replacing a previous source identity.
@param temporary - Complete private staging file.
@param destination - Immutable exact-source path.
@param content - Exact expected bytes for idempotent retries.
*/
async function installSource(temporary: string, destination: string, content: string) {
  const installed = await t(link, temporary, destination);

  if (installed.ok) {
    return;
  }

  const error = installed.error;

  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
    throw error;
  }

  if ((await readFile(destination, "utf8")) !== content) {
    throw new Error("Exact task source identity already has different bytes; inspect the retained originals.");
  }
}

/** Atomically retain one exact source once, including restart-safe retries and staging cleanup.
@param directory - Authorized private source directory.
@param name - Host-generated source basename.
@param content - Exact original bytes.
@returns Completion after an immutable source is installed or verified.
*/
export async function preserveTaskSource(directory: string, name: string, content: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${name}.${crypto.randomUUID()}.tmp`);
  const destination = path.join(directory, name);

  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  const installed = await t(installSource, temporary, destination, content);
  const removed = await t(unlink, temporary);

  valueAfterCleanup(installed, removed);
}
