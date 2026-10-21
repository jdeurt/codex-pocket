import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

const target = `gui/${String(process.getuid?.())}/dev.pocket.menubar`;
const STARTUP_PROBES = 20;
const PROBE_MS = 250;
const WINDOW_FLOW_TIMEOUT_MS = 20_000;

/** Build a disposable app around the real menu bar delegate and its native window flow.
@param home - Temporary directory containing the test app bundle.
@returns The compiled native flow executable.
*/
async function compileWindowFlow(home: string) {
  const contents = path.join(home, "Window Flow.app/Contents");
  const executable = path.join(contents, "MacOS/PocketMenuBar");
  const compilationTarget = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;
  const definition = {
    CFBundleIdentifier: `dev.pocket.menubar.window-flow.${randomUUID()}`,
    CFBundleName: "Pocket Window Flow",
    CFBundleExecutable: "PocketMenuBar",
    CFBundlePackageType: "APPL",
    LSUIElement: true,
    LSMinimumSystemVersion: "13.0",
    PocketURL: "http://127.0.0.1:1",
  };

  await mkdir(path.dirname(executable), { recursive: true });
  assert.equal(
    spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", path.join(contents, "Info.plist"), "-"], {
      input: JSON.stringify(definition),
    }).status,
    0
  );
  assert.equal(
    spawnSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-target",
        compilationTarget,
        "-warnings-as-errors",
        "-D",
        "MENUBAR_WINDOW_TEST",
        "scripts/menubar.swift",
        "tests/fixtures/menubar-window.swift",
        "-o",
        executable,
      ],
      { stdio: "inherit" }
    ).status,
    0
  );
  assert.equal(spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", path.dirname(contents)]).status, 0);

  return executable;
}

/** Exercise native focus, resizing, floating while inactive and retained drafts through the app boundary.
@param home - Disposable app directory, independent of the installed companion.
@returns Completion after the native window flow passes.
*/
async function checkWindowFlow(home: string) {
  const executable = await compileWindowFlow(home);
  const result = spawnSync(executable, [], { encoding: "utf8", timeout: WINDOW_FLOW_TIMEOUT_MS });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Native editor focus, focus ring, caret selection, resize, saved size/);
}

await test(
  "native window receives editor focus, resizes, stays on top while inactive, retains its draft and hides banners",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pocket-menubar-window-"));

    try {
      await checkWindowFlow(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
);

/** Wait for launchd to report a running native app after the public setup command.
@returns Completion after a running process is observed, or an assertion failure.
*/
async function requireRunning() {
  for (let probe = 0; probe < STARTUP_PROBES; probe += 1) {
    const job = spawnSync("/bin/launchctl", ["print", target], { encoding: "utf8" }).stdout;

    if (job.includes("state = running")) {
      return;
    }

    await setTimeout(PROBE_MS);
  }

  assert.fail("The native menu bar app did not start.");
}

await test(
  "menu bar CLI installs, starts at login, reinstalls, rejects invalid settings, and removes the native companion",
  { skip: process.platform !== "darwin" },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pocket-menubar-flow-"));
    const config = path.join(home, ".pocket/.env.local");
    const plist = path.join(home, "Library/LaunchAgents/dev.pocket.menubar.plist");
    const application = path.join(home, ".pocket/menubar/Pocket.app");
    const environment = { ...process.env, HOME: home };

    assert.notEqual(
      spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status,
      0,
      "Run this integration flow on a Mac without an installed Pocket Menu Bar job."
    );

    /** Execute the public command with isolated installation paths and real native tools.
    @param operation - Setup or remove operation.
    @param port - Optional port override used to exercise rejected configuration.
    @returns Captured command completion.
    */
    function command(operation: string, port?: string) {
      return spawnSync(process.execPath, ["scripts/pocket-cli.mjs", "menubar", operation], {
        env: { ...environment, POCKET_PORT: port },
        encoding: "utf8",
      });
    }

    /** Exercise setup twice, a rejected reconfiguration, and idempotent removal.
    @returns Completion of the native command flow and its file assertions.
    */
    async function flow() {
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, "POCKET_PORT=43877\n");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = command("setup");

        const definition: unknown = JSON.parse(
          spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }).stdout
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--deep", application]).status, 0);
        assert.match(
          spawnSync("/usr/bin/otool", ["-l", path.join(application, "Contents/MacOS/PocketMenuBar")], {
            encoding: "utf8",
          }).stdout,
          /minos\s+13\.0/
        );
        assert.equal(
          spawnSync(
            "/usr/bin/plutil",
            ["-extract", "PocketURL", "raw", path.join(application, "Contents/Info.plist")],
            {
              encoding: "utf8",
            }
          ).stdout.trim(),
          "http://127.0.0.1:43877"
        );
        assert.deepEqual(definition, {
          Label: "dev.pocket.menubar",
          ProgramArguments: [path.join(application, "Contents/MacOS/PocketMenuBar")],
          RunAtLoad: true,
          KeepAlive: { SuccessfulExit: false },
          ProcessType: "Interactive",
          StandardOutPath: path.join(home, ".pocket/logs/menubar.log"),
          StandardErrorPath: path.join(home, ".pocket/logs/menubar.err.log"),
        });

        await requireRunning();
      }

      {
        const invalid = command("setup", "invalid");

        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /POCKET_PORT must be a port number/);
        assert.equal(spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status, 0);
        assert.equal(await readFile(config, "utf8"), "POCKET_PORT=43877\n");
      }

      assert.equal(command("remove").status, 0);
      assert.equal(command("remove").status, 0);
      assert.notEqual(spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status, 0);
      await assert.rejects(readFile(plist), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(application, "Contents/Info.plist")), { code: "ENOENT" });
      assert.equal(await readFile(config, "utf8"), "POCKET_PORT=43877\n");
    }

    try {
      await flow();
    } finally {
      command("remove");
      await rm(home, { recursive: true, force: true });
    }
  }
);
