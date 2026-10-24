import { readFile, realpath, readdir } from "node:fs/promises";
import { t } from "try";

/** Read optional filesystem evidence, propagating failures other than an absent path.
@param read - Filesystem operation with explicit arguments.
@param args - Arguments passed to that operation.
@returns Read value, or null for a missing/deleted path.
*/
export async function optionalFile<T, Args extends unknown[]>(
  read: (...args: Args) => Promise<T>,
  ...args: Args
): Promise<T | null> {
  const result = await t(read, ...args);

  if (result.ok) {
    return result.value;
  }

  const error = result.error;

  if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
    return null;
  }

  throw error;
}

/** Read text with an explicit encoding at the native filesystem boundary.
@param file - Authorized native pathname.
@returns UTF-8 file contents.
*/
export function fileText(file: string) {
  return readFile(file, "utf8");
}

/** Resolve a native path using string output.
@param file - Explicit native pathname.
@returns Canonical string pathname.
*/
export function canonicalPath(file: string) {
  return realpath(file);
}

/** Read directory entry names using the native string-returning overload.
@param directory - Authorized directory.
@returns Native entry names.
*/
export function directoryNames(directory: string) {
  return readdir(directory);
}
