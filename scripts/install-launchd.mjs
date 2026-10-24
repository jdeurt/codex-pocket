import { optionalFile, replaceFile } from "./install-files.mjs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { spawnSync } from "node:child_process";

const LABEL = "dev.pocket.web";
const RETRIES = 30;
const RETRY_MS = 1000;
const BOOTSTRAP_BUSY = 5;

/** Run one native service command, reporting unsuccessful exits without swallowing spawn failures.
@param {string} executable - Absolute native executable.
@param {string[]} args - Literal command arguments.
@param {string | Buffer} [input] - Optional standard input.
@returns {string} Successful command output.
*/
function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: "utf8" });

  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? (result.stderr || `${executable} failed.`));
  }

  return result.stdout;
}

/** Wait until the owned service releases its port; never kill an unrelated listener.
@param {number} port - Configured loopback port.
@returns {Promise<void>} Completion of port release.
*/
async function waitForPort(port) {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    /**
    @type {Promise<boolean>}
    */
    const probeResult = new Promise((resolve, reject) => {
      const probe = createServer();

      probe.once("error", (error) => {
        if ("code" in error && error.code === "EADDRINUSE") {
          resolve(false);
        } else {
          reject(error);
        }
      });
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => {
          resolve(true);
        });
      });
    });

    const isAvailable = await probeResult;

    if (isAvailable) {
      return;
    }

    await setTimeout(RETRY_MS);
  }

  throw new Error(`Port ${String(port)} is still in use; no unrelated process was stopped.`);
}

/** Register a service after launchd has finished removing its previous job.
@param {string} domain - Logged-in launchd GUI domain.
@param {string} plist - Private saved service definition.
@returns {Promise<void>} Completion of native registration.
*/
async function bootstrap(domain, plist) {
  for (let attempt = 0; ; attempt += 1) {
    const result = spawnSync("/bin/launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });

    if (result.status === 0) {
      return;
    }

    if (result.status !== BOOTSTRAP_BUSY || attempt >= RETRIES) {
      throw new Error(result.error?.message ?? (result.stderr || "Could not start Pocket's login service."));
    }

    await setTimeout(RETRY_MS);
  }
}

/** Probe the web server without initializing a conversation or sending a model turn.
@param {number} port - Configured loopback port.
@returns {Promise<boolean>} Whether the web manifest is served successfully.
*/
async function isResponding(port) {
  const response = await globalThis.fetch(`http://127.0.0.1:${String(port)}/manifest.webmanifest`, {
    signal: AbortSignal.timeout(RETRY_MS),
  });

  await response.arrayBuffer();

  return response.ok;
}

/** Require the newly started web server to answer before accepting the service switch.
@param {number} port - Configured loopback port.
@returns {Promise<void>} Completion of HTTP readiness, or a startup failure.
*/
async function ready(port) {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    // Next may briefly refuse connections while loading the completed build.
    const isAvailable = await isResponding(port).catch(() => false);

    if (isAvailable) {
      return;
    }

    await setTimeout(RETRY_MS);
  }

  throw new Error("Pocket did not become ready after launch; restoring the previous service.");
}

/** Construct a release-specific service while keeping state and logs at their original locations.
@param {string} root - Private Pocket home.
@param {string} release - Validated runtime directory.
@param {number} port - Loopback listener.
@param {Partial<NodeJS.ProcessEnv>} environment - Existing settings used to resolve relative private paths.
@returns Native property-list definition.
*/
export function serviceDefinition(root, release, port, environment) {
  const local = path.resolve(root, environment.CODEX_POCKET_STATE_DIR ?? "data");
  const logs = path.resolve(root, environment.CODEX_POCKET_LOG_DIR ?? "logs");
  const searchPath = [
    ...new Set([path.dirname(process.execPath), ...(process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)]),
  ].join(path.delimiter);

  return {
    Label: LABEL,
    ProgramArguments: [
      process.execPath,
      path.join(release, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    WorkingDirectory: release,
    EnvironmentVariables: {
      PATH: searchPath,
      NODE_ENV: "production",
      POCKET_HOME: root,
      CODEX_POCKET_STATE_DIR: local,
      CODEX_POCKET_LOG_DIR: logs,
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ExitTimeOut: 20,
    ProcessType: "Interactive",
    StandardOutPath: path.join(logs, "pocket.log"),
    StandardErrorPath: path.join(logs, "pocket.err.log"),
  };
}

/** Snapshot the owned service before building and provide recoverable activation operations.
@param {string} root - Private Pocket home.
@param {number} port - Validated loopback port.
@param {number} userId - Logged-in macOS user.
@param {NodeJS.ProcessEnv} environment - Saved private path configuration.
@returns {Promise<{stop: () => Promise<void>, start: (release: string) => Promise<void>, restore: () => Promise<void>}>} Service operations retaining the previous definition.
*/
export async function loginService(root, port, userId, environment) {
  const plist = path.join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${String(userId)}`;
  const target = `${domain}/${LABEL}`;
  const previous = await optionalFile(plist);
  const wasRunning = spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status === 0;

  if (!previous && wasRunning) {
    throw new Error("The running Pocket service has no saved definition; resolve it before installing.");
  }

  return {
    async stop() {
      if (spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status === 0) {
        command("/bin/launchctl", ["bootout", target]);
      }

      await waitForPort(port);
    },
    async start(release) {
      const definition = serviceDefinition(root, release, port, environment);
      const xml = command("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], JSON.stringify(definition));

      await mkdir(path.dirname(plist), { recursive: true });
      await mkdir(path.dirname(definition.StandardOutPath), { recursive: true, mode: 0o700 });
      await replaceFile(path.join(release, ".rollback.plist"), previous);
      await replaceFile(plist, Buffer.from(xml));
      await bootstrap(domain, plist);
      await ready(port);
      console.info(`Installed ${target} from ${release}. Pocket starts at login and restarts after a crash.`);
    },
    async restore() {
      await replaceFile(plist, previous);

      if (!wasRunning) {
        return;
      }

      await bootstrap(domain, plist);
      console.info("Restored the previous Pocket login service.");
    },
  };
}
