import { URL, fileURLToPath } from "node:url";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const home = path.join(homedir(), ".pocket");
export const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_TCP_PORT = 65_535;
const NPM_CLI = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");

/**
Runs an installer subprocess and rejects unsuccessful exit or spawn failure.
@param {string} command - Executable path.
@param {string[]} args - Literal argument vector.
@param {NodeJS.ProcessEnv} [environment] - Child environment, defaulting to this process.
@param {string} [directory] - Isolated release or owning checkout.
*/
export function run(command, args, environment = process.env, directory = root) {
  const result = spawnSync(command, args, { stdio: "inherit", env: environment, cwd: directory });

  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed${result.error ? `: ${result.error.message}` : "."}`);
  }
}

/**
Runs Pocket's private Node runtime with its adjacent npm CLI.
@param {string[]} args - npm argument vector.
@param {NodeJS.ProcessEnv} [environment] - Child environment.
@param {string} [directory] - Isolated release or owning checkout.
*/
export function npm(args, environment = process.env, directory = root) {
  run(process.execPath, [NPM_CLI, ...args], environment, directory);
}

/**
Resolves an executable through an absolute candidate or the current search path.
@param {string} candidate - Executable name or absolute path.
@returns {Promise<string | undefined>} Canonical executable path, or undefined if none is accessible.
*/
async function executable(candidate) {
  const paths = path.isAbsolute(candidate)
    ? [candidate]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, candidate));

  for (const file of paths) {
    const resolved = await access(file, constants.X_OK)
      .then(() => realpath(file))
      .catch(() => {
        // Try the next executable location.
      });

    if (resolved) {
      return resolved;
    }
  }
}

/**
Retains an explicit or saved port, including legacy local-origin configuration.
@param {NodeJS.ProcessEnv} saved - Parsed saved dotenv settings.
@returns {number} Valid TCP port; invalid explicit configuration throws.
*/
export function configuredPort(saved) {
  const savedLocalOrigin = saved.CODEX_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .find((origin) => /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin));
  const value =
    process.env.POCKET_PORT ?? saved.POCKET_PORT ?? (savedLocalOrigin && new URL(savedLocalOrigin).port) ?? "3000";
  const port = Number(value);

  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    throw new Error("POCKET_PORT must be a port number from 1 to 65535.");
  }

  return port;
}

/**
Checks the executable produced by the completed private npm installation.
@returns {Promise<string>} Canonical executable path; missing output rejects.
*/
async function installedCodex() {
  const installed = await executable(path.join(home, "codex/node_modules/.bin/codex"));

  if (!installed) {
    throw new Error("Codex installation did not create an executable.");
  }

  return installed;
}

/**
Installs a private Codex executable after all existing candidates are exhausted.
@returns {Promise<string>} Canonical installed executable path.
*/
async function installCodex() {
  console.info("Installing Codex privately for Pocket…");
  npm(["install", "--prefix", path.join(home, "codex"), "--no-save", "--package-lock=false", "@openai/codex"]);

  return await installedCodex();
}

/**
Finds an existing native Codex binary before attempting a private installation.
@param {NodeJS.ProcessEnv} saved - Parsed saved dotenv settings.
@returns {Promise<string>} Canonical executable path.
*/
export async function findCodex(saved) {
  const preferred = process.env.CODEX_BINARY ?? saved.CODEX_BINARY;
  const candidates = [
    ...(preferred ? [preferred] : []),
    "codex",
    path.join(home, "codex/node_modules/.bin/codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    path.join(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];

  for (const candidate of candidates) {
    const file = await executable(candidate);

    if (file) {
      return file;
    }
  }

  return await installCodex();
}
