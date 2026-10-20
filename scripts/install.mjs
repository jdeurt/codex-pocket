import { configuredPort, findCodex, npm, root, run, stopService } from "./install-runtime.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import path from "node:path";
import { setupOrigin } from "./setup-env.ts";
import { spawnSync } from "node:child_process";

const options = process.argv.slice(2);
const NODE_MAJOR = 24;

/**
Reads private saved configuration, treating only a missing dotenv file as empty.
@returns {Promise<NodeJS.ProcessEnv>} Parsed literal settings; other filesystem errors reject.
*/
async function savedEnvironment() {
  try {
    return parseEnv(await readFile(path.join(root, ".env.local"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }

    return {};
  }
}

/**
Asks for one setup value, retaining the fallback when guided setup is disabled.
@param {import("node:readline/promises").Interface | undefined} prompt - Active guided setup input.
@param {string} label - Displayed question.
@param {string} fallback - Saved or default value.
@returns {Promise<string>} Trimmed answer, or the fallback for an empty answer.
*/
async function ask(prompt, label, fallback) {
  if (prompt) {
    const response = await prompt.question(`${label}${fallback ? ` [${fallback}]` : ""}: `);

    return response.trim() || fallback;
  }

  return fallback;
}

/**
Builds the child environment after collecting setup choices, without inheriting an agent thread.
@param {NodeJS.ProcessEnv} saved - Saved configuration.
@param {string} cwd - Selected absolute working folder.
@param {number} port - Validated TCP port.
@param {string} origin - Canonical phone origin, or empty for local setup.
@returns {NodeJS.ProcessEnv} Environment for setup and service installation.
*/
function installationEnvironment(saved, cwd, port, origin) {
  const origins = new Set((saved.CODEX_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean));

  origins.add(`http://localhost:${String(port)}`);
  origins.add(`http://127.0.0.1:${String(port)}`);

  return {
    ...process.env,
    CODEX_THREAD_ID: undefined,
    CODEX_CWD: cwd,
    CODEX_ALLOWED_ORIGINS: [...origins].join(","),
    POCKET_ORIGIN: origin,
    POCKET_PORT: String(port),
  };
}

/**
Collects working-folder and phone-origin choices in their original prompt order.
@param {NodeJS.ProcessEnv} saved - Saved configuration.
@param {import("node:readline/promises").Interface | undefined} prompt - Guided setup input.
@returns {Promise<{port: number, cwd: string, origin: string, environment: NodeJS.ProcessEnv}>} Validated setup choices.
*/
async function settings(saved, prompt) {
  const port = configuredPort(saved);
  const defaultFolder = process.env.POCKET_CWD ?? saved.CODEX_CWD ?? path.join(homedir(), "Developer");
  const folder = await ask(prompt, "Working folder", defaultFolder);
  const cwd = path.resolve(folder === "~" ? homedir() : folder.replace(/^~\//, () => `${homedir()}/`));
  const existingOrigin = saved.CODEX_ALLOWED_ORIGINS?.split(",").find((origin) => origin.startsWith("https://"));
  const enteredOrigin = await ask(
    prompt,
    "Phone HTTPS address (optional; - to skip)",
    process.env.POCKET_ORIGIN ?? existingOrigin ?? ""
  );
  const origin = setupOrigin(enteredOrigin === "-" ? "" : enteredOrigin) ?? "";

  return { port, cwd, origin, environment: installationEnvironment(saved, cwd, port, origin) };
}

/**
Collects and validates the permissions choice when no server arguments are configured.
@param {import("node:readline/promises").Interface | undefined} prompt - Guided setup input.
@returns {Promise<string | undefined>} Explicit full-access arguments, or undefined for native defaults.
*/
async function selectedServerArgs(prompt) {
  const selection = await ask(prompt, "Codex permissions: default or full", "default");

  if (!["default", "full"].includes(selection)) {
    throw new Error("Choose default or full for Codex permissions.");
  }

  if (selection === "full") {
    return JSON.stringify([
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    ]);
  }
}

/**
Checks native app-server support after any required authentication has finished.
@param {string} codex - Resolved executable path.
*/
function requireAppServer(codex) {
  const supported = spawnSync(codex, ["app-server", "--help"], { stdio: "ignore" });

  if (supported.status !== 0) {
    throw new Error("This Codex executable lacks app-server support. Update Codex and run the installer again.");
  }
}

/**
Finds and authenticates the selected native executable before touching the running Pocket service.
@param {NodeJS.ProcessEnv} saved - Saved binary preference.
@param {NodeJS.ProcessEnv} environment - Child environment receiving the resolved binary.
@param {boolean} isInteractive - Whether guided authentication is permitted.
@returns {Promise<void>} Completion of binary, login and app-server checks.
*/
async function prepareCodex(saved, environment, isInteractive) {
  const codex = await findCodex(saved);

  environment.CODEX_BINARY = codex;

  if (spawnSync(codex, ["login", "status"], { stdio: "ignore" }).status !== 0) {
    if (!isInteractive) {
      throw new Error("Sign in to Codex on this Mac, then rerun the installer without --yes for guided setup.");
    }

    console.info("Complete Codex sign-in in the window that opens…");
    run(codex, ["login"]);
  }

  requireAppServer(codex);
}

/**
Runs the ordered installer after all platform and option guards have succeeded.
@param {number} userId - Verified logged-in macOS user.
@param {boolean} isInteractive - Whether setup can prompt and open a browser.
@param {import("node:readline/promises").Interface | undefined} prompt - Guided setup input.
@returns {Promise<void>} Completion of installation; failures leave saved state available for retry.
*/
async function install(userId, isInteractive, prompt) {
  const saved = await savedEnvironment();
  const { port, cwd, origin, environment } = await settings(saved, prompt);

  if (!saved.CODEX_SERVER_ARGS && !process.env.CODEX_SERVER_ARGS) {
    environment.CODEX_SERVER_ARGS = await selectedServerArgs(prompt);
  }

  await mkdir(cwd, { recursive: true });
  await prepareCodex(saved, environment, isInteractive);
  await stopService(port, userId);
  console.info("Installing Pocket's dependencies…");
  npm(["ci", "--no-audit", "--no-fund"]);
  npm(["run", "setup"], environment);
  run(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "typegen"], environment);
  npm(["run", "check"]);

  if (process.env.CI === "true") {
    npm(["test"]);
  }

  npm(["run", "build"]);
  npm(["run", "service:install"], environment);
  console.info(`\nPocket is installed and starts at login. Open ${origin || `http://127.0.0.1:${String(port)}`}`);
  console.info("Configuration: .env.local   State and logs: .local/");

  if (isInteractive) {
    spawnSync("/usr/bin/open", [origin || `http://127.0.0.1:${String(port)}`], { stdio: "ignore" });
  }
}

/**
Owns the interactive input resource and reports recoverable installer failures.
@param {number} userId - Verified logged-in macOS user.
@returns {Promise<void>} Completion of installation and prompt cleanup.
*/
async function guidedInstall(userId) {
  const isInteractive = !options.includes("--yes") && process.stdin.isTTY;
  const prompt = isInteractive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

  try {
    await install(userId, isInteractive, prompt);
  } catch (error) {
    console.error(`\nPocket installation stopped: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "Your saved configuration and conversation state are preserved. Fix the reported problem and rerun ./install.sh."
    );
    process.exitCode = 1;
  } finally {
    prompt?.close();
  }
}

/**
Validates the platform, private runtime and command line before opening guided input.
@returns {Promise<void>} Completion of the guarded installer invocation.
*/
async function launch() {
  const userId = process.getuid?.();

  if (userId === undefined || process.platform !== "darwin") {
    throw new Error("The Pocket installer requires a logged-in macOS user.");
  }

  if (Number(process.versions.node.split(".", 1)[0]) !== NODE_MAJOR) {
    throw new Error("Run ./install.sh to use Pocket's private Node.js 24 runtime.");
  }

  if (options.some((option) => option !== "--yes")) {
    throw new Error("Usage: ./install.sh [--yes]");
  }

  await guidedInstall(userId);
}

process.chdir(root);
await launch();
