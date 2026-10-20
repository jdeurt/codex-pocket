import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const PRIVATE_MODE = 0o600;

/** Read a saved file without treating permission or storage errors as absence.
@param {string} file - Private configuration path.
@returns {Promise<Buffer | undefined>} Existing bytes, or undefined only when missing.
*/
export async function optionalFile(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/** Atomically restore saved bytes, or remove a file that did not previously exist.
@param {string} file - Configuration destination.
@param {Buffer | undefined} contents - Saved bytes or an absent original.
@returns {Promise<void>} Completion of private replacement.
*/
export async function replaceFile(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;

  if (contents === undefined) {
    await rm(file, { force: true });

    return;
  }

  try {
    await writeFile(temporary, contents, { mode: PRIVATE_MODE });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
