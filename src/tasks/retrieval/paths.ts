import { optionalFile, canonicalPath } from "../../server/optional-file";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { localDirectory } from "../../server/local-state";
import { taskDirectory } from "../archive";

/** Check a source path belongs to this exact parent and is not a symlink into another namespace.
@param owner - Authorized parent identity.
@param file - Existing archive, detail view or source path.
@returns Whether the file is a regular, unredirected descendant of the parent directory.
*/
export async function isParentTaskFile(owner: string, file: string) {
  const root = taskDirectory(owner);

  if (!file.startsWith(root + path.sep)) {
    return false;
  }

  const stateRoot = await optionalFile(canonicalPath, localDirectory());
  const expected = stateRoot ? path.join(stateRoot, path.relative(localDirectory(), file)) : null;
  const resolved = await optionalFile(canonicalPath, file);
  const info = await optionalFile(stat, file);

  return resolved === expected && info?.isFile() === true;
}

/** Create index directories only inside the canonical parent namespace, rejecting redirected index files.
@param owner - Authorized parent identity.
@returns Verified private index directory.
*/
export async function taskIndexDirectory(owner: string) {
  const root = taskDirectory(owner);

  await mkdir(localDirectory(), { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(localDirectory());
  const directories = [
    path.join(localDirectory(), "tasks"),
    root,
    path.join(root, "qmd"),
    path.join(root, "qmd", "views"),
  ];

  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });

    if ((await realpath(directory)) !== path.join(stateRoot, path.relative(localDirectory(), directory))) {
      throw new Error("Task index directory redirects outside its parent namespace.");
    }
  }

  const index = path.join(root, "qmd");

  for (const name of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) {
    const info = await optionalFile(lstat, path.join(index, name));

    if (info?.isSymbolicLink()) {
      throw new Error("Task index database redirects outside its parent namespace.");
    }
  }

  return index;
}
