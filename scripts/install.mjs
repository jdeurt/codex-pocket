import { URL, fileURLToPath } from "node:url";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { setupOrigin } from "./setup-env.ts";
import { spawnSync } from "node:child_process";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = process.argv.slice(2);
process.chdir(root);

if (process.platform !== "darwin" || process.getuid?.() === undefined) {
  throw new Error("The Pocket installer requires a logged-in macOS user.");
}

const NODE_MAJOR = 24;

if (Number(process.versions.node.split(".", 1)[0]) !== NODE_MAJOR) {
  throw new Error("Run ./install.sh to use Pocket's private Node.js 24 runtime.");
}

if (options.some((option) => option !== "--yes")) {
  throw new Error("Usage: ./install.sh [--yes]");
}

const STOP_RETRIES = 80;
const STOP_INTERVAL_MS = 250;
const MAX_TCP_PORT = 65_535;
const NPM_CLI = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");

const interactive = !options.includes("--yes") && process.stdin.isTTY;
const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
const domain = `gui/${process.getuid()}`;
const target = `${domain}/dev.pocket.web`;

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env: environment });

  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed${result.error ? `: ${result.error.message}` : "."}`);
  }
}

function npm(args, environment = process.env) {
  run(process.execPath, [NPM_CLI, ...args], environment);
}

async function ask(label, fallback) {
  if (!prompt) {
    return fallback;
  }

  const response = await prompt.question(`${label}${fallback ? ` [${fallback}]` : ""}: `);
  const answer = response.trim();

  return answer || fallback;
}

async function executable(candidate) {
  const paths = path.isAbsolute(candidate)
    ? [candidate]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, candidate));

  for (const file of paths) {
    try {
      await access(file, constants.X_OK);

      return await realpath(file);
    } catch {
      // Try the next installation location.
    }
  }
}

async function findCodex(saved) {
  const preferred = process.env.CODEX_BINARY ?? saved.CODEX_BINARY;
  const candidates = [
    ...(preferred ? [preferred] : []),
    "codex",
    path.join(root, ".local/codex/node_modules/.bin/codex"),
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

  console.info("Installing Codex privately for Pocket…");
  npm(["install", "--prefix", path.join(root, ".local/codex"), "--no-save", "--package-lock=false", "@openai/codex"]);
  const installed = await executable(path.join(root, ".local/codex/node_modules/.bin/codex"));

  if (!installed) {
    throw new Error("Codex installation did not create an executable.");
  }

  return installed;
}

function configuredPort(saved) {
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

async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(error);
      }
    });
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function stopService(port) {
  const present = spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status === 0;

  if (present) {
    const plist = path.join(homedir(), "Library/LaunchAgents/dev.pocket.web.plist");
    const location = spawnSync("/usr/bin/plutil", ["-extract", "WorkingDirectory", "raw", "-o", "-", plist], {
      encoding: "utf8",
    });

    if (location.status !== 0 || path.resolve(location.stdout.trim()) !== root) {
      throw new Error("Another Pocket checkout owns the login service. Run its installer to update that installation.");
    }

    console.info("Stopping Pocket before replacing dependencies and build assets…");
    run("/bin/launchctl", ["bootout", target]);
  }

  for (let attempt = 0; attempt <= STOP_RETRIES; attempt += 1) {
    if (await portAvailable(port)) {
      return;
    }

    if (!present || attempt === STOP_RETRIES) {
      throw new Error(`Port ${port} is in use. Stop the application using that port, then run this installer again.`);
    }

    await setTimeout(STOP_INTERVAL_MS);
  }
}

async function install() {
  let saved = {};

  try {
    saved = parseEnv(await readFile(path.join(root, ".env.local"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const port = configuredPort(saved);
  const defaultFolder = process.env.POCKET_CWD ?? saved.CODEX_CWD ?? path.join(homedir(), "Developer");
  const folder = await ask("Working folder", defaultFolder);
  const cwd = path.resolve(folder === "~" ? homedir() : folder.replace(/^~\//, () => `${homedir()}/`));
  const existingOrigin = saved.CODEX_ALLOWED_ORIGINS?.split(",").find((origin) => origin.startsWith("https://"));
  const enteredOrigin = await ask(
    "Phone HTTPS address (optional; - to skip)",
    process.env.POCKET_ORIGIN ?? existingOrigin ?? ""
  );
  const origin = setupOrigin(enteredOrigin === "-" ? "" : enteredOrigin) ?? "";
  const origins = new Set((saved.CODEX_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean));
  origins.add(`http://localhost:${port}`);
  origins.add(`http://127.0.0.1:${port}`);
  const environment = {
    ...process.env,
    CODEX_CWD: cwd,
    CODEX_ALLOWED_ORIGINS: [...origins].join(","),
    POCKET_ORIGIN: origin,
    POCKET_PORT: String(port),
  };
  delete environment.CODEX_THREAD_ID;

  if (!saved.CODEX_SERVER_ARGS && !process.env.CODEX_SERVER_ARGS) {
    const permissions = await ask("Codex permissions: default or full", "default");

    if (!["default", "full"].includes(permissions)) {
      throw new Error("Choose default or full for Codex permissions.");
    }

    if (permissions === "full") {
      environment.CODEX_SERVER_ARGS = JSON.stringify([
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

  await mkdir(cwd, { recursive: true });
  const codex = await findCodex(saved);
  environment.CODEX_BINARY = codex;
  const login = spawnSync(codex, ["login", "status"], { stdio: "ignore" });

  if (login.status !== 0) {
    if (!interactive) {
      throw new Error("Sign in to Codex on this Mac, then rerun the installer without --yes for guided setup.");
    }

    console.info("Complete Codex sign-in in the window that opens…");
    run(codex, ["login"]);
  }

  const supported = spawnSync(codex, ["app-server", "--help"], { stdio: "ignore" });

  if (supported.status !== 0) {
    throw new Error("This Codex executable lacks app-server support. Update Codex and run the installer again.");
  }

  await stopService(port);
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
  console.info(`\nPocket is installed and starts at login. Open ${origin || `http://127.0.0.1:${port}`}`);
  console.info("Configuration: .env.local   State and logs: .local/");

  if (interactive) {
    spawnSync("/usr/bin/open", [origin || `http://127.0.0.1:${port}`], { stdio: "ignore" });
  }
}

try {
  await install();
} catch (error) {
  console.error(`\nPocket installation stopped: ${error.message}`);
  console.error(
    "Your saved configuration and conversation state are preserved. Fix the reported problem and rerun ./install.sh."
  );
  process.exitCode = 1;
} finally {
  prompt?.close();
}
