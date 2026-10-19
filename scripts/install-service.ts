import { chmod, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const userId = process.getuid?.();

if (process.platform !== "darwin" || userId === undefined) {
  throw new Error("This service installer requires macOS. Run npm start under a service manager on other systems.");
}

const label = "dev.pocket.web";
const port = "3000";
const PRIVATE_FILE_MODE = 0o600;
const BOOTSTRAP_RETRY_LIMIT = 30;
const SERVICE_RETRY_MS = 1000;
const RETRYABLE_BOOTSTRAP_STATUS = 5;
const root = process.cwd();
const logs = path.join(root, ".local", "logs");
const agents = path.join(homedir(), "Library", "LaunchAgents");
const plist = path.join(agents, `${label}.plist`);
const domain = `gui/${userId}`;
const target = `${domain}/${label}`;
const searchPath = [
  ...new Set([path.dirname(process.execPath), ...(process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)]),
].join(path.delimiter);

await mkdir(logs, { recursive: true, mode: 0o700 });
await mkdir(agents, { recursive: true });
const definition = {
  Label: label,
  ProgramArguments: [
    process.execPath,
    path.join(root, "node_modules", "next", "dist", "bin", "next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ],
  WorkingDirectory: root,
  EnvironmentVariables: { PATH: searchPath, NODE_ENV: "production" },
  RunAtLoad: true,
  KeepAlive: true,
  ThrottleInterval: 10,
  ExitTimeOut: 20,
  ProcessType: "Interactive",
  StandardOutPath: path.join(logs, "pocket.log"),
  StandardErrorPath: path.join(logs, "pocket.err.log"),
};

if (spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status === 0) {
  execFileSync("/bin/launchctl", ["bootout", target]);
}

execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", plist, "-"], { input: JSON.stringify(definition) });
await chmod(plist, PRIVATE_FILE_MODE);

// launchd can still be removing a stopped job after bootout returns.
for (let attempt = 0; ; attempt += 1) {
  const result = spawnSync("/bin/launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });

  if (result.status === 0) {
    break;
  }

  if (result.status !== RETRYABLE_BOOTSTRAP_STATUS || attempt >= BOOTSTRAP_RETRY_LIMIT) {
    throw new Error(result.stderr || result.error?.message || "Could not start Pocket's login service.");
  }

  await setTimeout(SERVICE_RETRY_MS);
}

console.info(`Installed ${target}. Pocket starts at login and restarts after a crash.`);
console.info(`Logs: ${logs}`);
