import { chmod, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { optionalFile, replaceFile } from "./install-files.mjs";
import { homedir } from "node:os";
import path from "node:path";

const EXECUTABLE_MODE = 0o700;
const PATH_LINE = 'export PATH="$HOME/.pocket/bin:$PATH"';

/** Install a stable launcher that follows the accepted release and its pinned runtime.
@param {string} home - Private Pocket home.
@returns {Promise<void>} Completion of launcher creation.
*/
export async function installLauncher(home) {
  const file = path.join(home, "bin/pocket");
  const script =
    '#!/bin/sh\nexec "$HOME/.pocket/current/.pocket-node" "$HOME/.pocket/current/scripts/pocket-cli.mjs" "$@"\n';

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await replaceFile(file, Buffer.from(script));
  await chmod(file, EXECUTABLE_MODE);
}

/** Replace a symlink through an adjacent atomic rename.
@param {string} file - Stable release pointer.
@param {string} target - Accepted release directory.
@returns {Promise<void>} Completion of pointer replacement.
*/
async function replaceLink(file, target) {
  const temporary = `${file}.pending`;

  await rm(temporary, { force: true });
  await symlink(target, temporary);
  await rename(temporary, file);
}

/** Atomically select the accepted release without rewriting the launcher on every update.
@param {string} home - Private Pocket home.
@param {string | undefined} release - New or previous release; undefined restores a fresh installation.
@returns {Promise<void>} Completion of pointer replacement.
*/
export async function selectRelease(home, release) {
  const current = path.join(home, "current");

  if (!release) {
    await rm(current, { force: true });

    return;
  }

  await replaceLink(current, release);
}

/** Read the currently accepted release before beginning a switch.
@param {string} home - Private Pocket home.
@returns {Promise<string | undefined>} Previous release target, absent only on first installation.
*/
export async function currentRelease(home) {
  return (async () => readlink(path.join(home, "current")))().catch((/** @type {unknown} */ error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  });
}

/** Preserve existing shell settings while adding the executable search path once.
@param {string} file - Selected shell startup file.
@returns {Promise<void>} Completion of idempotent PATH setup.
*/
async function appendPath(file) {
  const contents = await optionalFile(file);
  const source = contents?.toString() ?? "";

  if (!source.split("\n").includes(PATH_LINE)) {
    await replaceFile(file, Buffer.from(`${source.trimEnd()}\n\n# Pocket commands\n${PATH_LINE}\n`));
  }
}

/** Add the Pocket executable directory once to the user's selected shell startup file.
@param {string} [userHome] - Home directory containing shell startup files.
@param {string} [shell] - Login shell path.
@returns {Promise<void>} Completion of PATH configuration for new shells.
*/
export async function installPath(userHome = homedir(), shell = process.env.SHELL ?? "/bin/zsh") {
  const name = path.basename(shell);

  if (!["bash", "zsh"].includes(name)) {
    console.info("Add ~/.pocket/bin to your shell PATH to use the pocket command.");

    return;
  }

  await appendPath(path.join(userHome, name === "bash" ? ".bash_profile" : ".zshrc"));
}
