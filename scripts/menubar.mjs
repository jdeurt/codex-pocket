import { configuredPort, home, root, run } from "./install-runtime.mjs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { optionalFile, replaceFile } from "./install-files.mjs";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withInstallLock } from "./install-release.mjs";

const LABEL = "dev.pocket.menubar";
const directory = path.join(home, "menubar");
const application = path.join(directory, "Pocket.app");
const plist = path.join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${String(process.getuid?.())}`;
const target = `${domain}/${LABEL}`;

/** Stop the menu bar companion if its login job is registered.
 */
function stop() {
  if (spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status === 0) {
    run("/bin/launchctl", ["bootout", target]);
  }
}

/** Convert a native property list without interpolating paths or settings into XML.
@param {object} definition - Native property-list contents.
@returns {Buffer} XML accepted by launchd and app bundle readers.
*/
function propertyList(definition) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], {
    input: JSON.stringify(definition),
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? (result.stderr.toString() || "Could not create the menu bar property list.")
    );
  }

  return result.stdout;
}

/** Build the native companion before replacing its files or login job.
@returns {Promise<void>} Completion of installation and login registration.
*/
async function setup() {
  const contentsFile = await optionalFile(path.join(home, ".env.local"));
  const saved = parseEnv(contentsFile?.toString() ?? "");
  const url = `http://127.0.0.1:${String(configuredPort(saved))}`;
  const stage = await mkdtemp(path.join(directory, "build-"));
  const bundle = path.join(stage, "Pocket.app");
  const contents = path.join(bundle, "Contents");
  const executable = path.join(contents, "MacOS/PocketMenuBar");
  const logs = path.join(home, "logs");
  const compilationTarget = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;

  try {
    await mkdir(path.dirname(executable), { recursive: true });
    run("/usr/bin/xcrun", [
      "swiftc",
      "-parse-as-library",
      "-target",
      compilationTarget,
      "-O",
      path.join(root, "scripts/menubar.swift"),
      "-o",
      executable,
    ]);
    await writeFile(
      path.join(contents, "Info.plist"),
      propertyList({
        CFBundleIdentifier: LABEL,
        CFBundleName: "Pocket Menu Bar",
        CFBundleExecutable: "PocketMenuBar",
        CFBundlePackageType: "APPL",
        CFBundleVersion: "1",
        LSUIElement: true,
        LSMinimumSystemVersion: "13.0",
        PocketURL: url,
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSMicrophoneUsageDescription: "Pocket uses the microphone when you start a voice conversation.",
      })
    );
    run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
    await mkdir(path.dirname(plist), { recursive: true });
    await mkdir(logs, { recursive: true, mode: 0o700 });
    stop();
    await rm(application, { recursive: true, force: true });
    await rename(bundle, application);
    await replaceFile(
      plist,
      propertyList({
        Label: LABEL,
        ProgramArguments: [path.join(application, "Contents/MacOS/PocketMenuBar")],
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        ProcessType: "Interactive",
        StandardOutPath: path.join(logs, "menubar.log"),
        StandardErrorPath: path.join(logs, "menubar.err.log"),
      })
    );
    run("/bin/launchctl", ["enable", target]);
    run("/bin/launchctl", ["bootstrap", domain, plist]);
    console.info("Pocket Menu Bar is installed and starts at login. Click its icon to show or hide Pocket.");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Apply the requested companion operation without restarting the Pocket web service.
@returns {Promise<void>} Completion of setup or removal.
*/
async function main() {
  const [command, ...extra] = process.argv.slice(2);

  if (process.platform !== "darwin" || process.getuid?.() === undefined) {
    throw new Error("Pocket Menu Bar requires a logged-in macOS user.");
  }

  if (extra.length > 0 || !["setup", "remove"].includes(command)) {
    throw new Error("Usage: pocket menubar <setup|remove>");
  }

  await withInstallLock(home, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });

    if (command === "setup") {
      await setup();
    } else {
      stop();
      await rm(plist, { force: true });
      await rm(directory, { recursive: true, force: true });
      console.info("Pocket Menu Bar and its login startup are removed.");
    }
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
