import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const EXECUTABLE_MODE = 0o700;
const installer = path.resolve("install.sh");

/** Run local fixture Git without inherited user hooks, signing or authentication.
@param cwd - Disposable repository.
@param args - Literal Git arguments.
@returns Successful command output.
*/
function git(cwd: string, args: string[]) {
  return execFileSync(
    "/usr/bin/git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=Pocket Test", "-c", "user.email=pocket@example.invalid", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

/** Prepare a cached private runtime and local remote, without downloading or launching Pocket.
@param home - Disposable user home.
@returns Local Git remote and executable search path.
*/
async function bootstrapFixture(home: string) {
  const remote = path.join(home, "remote");
  const bin = path.join(home, "bin");
  const runtime = path.join(home, ".pocket/runtimes/node-24.22.0/bin");
  const node = path.join(runtime, "node");
  const shim = path.join(bin, "git");

  await mkdir(remote);
  await mkdir(bin);
  await mkdir(runtime, { recursive: true });
  git(remote, ["init", "--initial-branch=main"]);
  await writeFile(path.join(remote, "revision"), "first");
  git(remote, ["add", "."]);
  git(remote, ["commit", "-m", "first"]);
  await writeFile(
    shim,
    '#!/bin/sh\nif [ "$1" = clone ]; then\nexec /usr/bin/git clone --branch main --single-branch "$POCKET_TEST_REMOTE" "$6"\nfi\nexec /usr/bin/git "$@"\n'
  );
  await writeFile(
    node,
    '#!/bin/sh\nif [ "$1" = -e ]; then exit 0; fi\nprintf "install\\n" >> "$HOME/install-invocations"\ncat "$HOME/.pocket/source/revision" > "$HOME/launched-revision"\n'
  );
  await writeFile(path.join(runtime, "npm"), "#!/bin/sh\nexit 0\n");

  for (const file of [shim, node, path.join(runtime, "npm")]) {
    await chmod(file, EXECUTABLE_MODE);
  }

  return { remote, bin };
}

/** Run the public bootstrap command against the isolated local remote.
@param home - Disposable user home.
@param bin - Executable search path containing the local Git shim.
@param remote - Local fixture repository.
@param option - Installer mode.
@returns Command output.
*/
function runBootstrap(home: string, bin: string, remote: string, option: string) {
  return execFileSync("/bin/bash", [installer, option], {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      POCKET_TEST_REMOTE: remote,
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

await test(
  "bootstrap retries unaccepted revisions, skips accepted revisions, and refuses dirty managed source",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), "pocket-bootstrap-"));

    t.after(async () => {
      await rm(home, { recursive: true, force: true });
    });

    const { remote, bin } = await bootstrapFixture(home);

    runBootstrap(home, bin, remote, "--yes");
    assert.equal(await readFile(path.join(home, "launched-revision"), "utf8"), "first");
    assert.equal(await readFile(path.join(home, "install-invocations"), "utf8"), "install\n");
    await mkdir(path.join(home, ".pocket/current"));
    await writeFile(path.join(home, ".pocket/current/.pocket-source-revision"), git(remote, ["rev-parse", "HEAD"]));
    assert.match(runBootstrap(home, bin, remote, "--update").toString(), /already up to date/);
    assert.equal(await readFile(path.join(home, "install-invocations"), "utf8"), "install\n");
    runBootstrap(home, bin, remote, "--yes");
    assert.equal(await readFile(path.join(home, "install-invocations"), "utf8"), "install\ninstall\n");

    await writeFile(path.join(remote, "revision"), "second");
    git(remote, ["add", "."]);
    git(remote, ["commit", "-m", "second"]);
    runBootstrap(home, bin, remote, "--update");
    assert.equal(await readFile(path.join(home, "launched-revision"), "utf8"), "second");
    runBootstrap(home, bin, remote, "--update");
    assert.equal(
      await readFile(path.join(home, "install-invocations"), "utf8"),
      "install\ninstall\ninstall\ninstall\n"
    );

    await writeFile(path.join(home, ".pocket/current/.pocket-source-revision"), git(remote, ["rev-parse", "HEAD"]));
    assert.match(runBootstrap(home, bin, remote, "--update").toString(), /already up to date/);
    assert.equal(
      await readFile(path.join(home, "install-invocations"), "utf8"),
      "install\ninstall\ninstall\ninstall\n"
    );

    await writeFile(path.join(home, ".pocket/source/revision"), "local edit");
    assert.throws(() => runBootstrap(home, bin, remote, "--update"), /local changes/);
    assert.equal(await readFile(path.join(home, ".pocket/source/revision"), "utf8"), "local edit");
    await assert.rejects(readFile(path.join(home, ".pocket/bootstrap.lock")), { code: "ENOENT" });
  }
);

await test(
  "installer reaches setup validation without installed dependencies",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const bare = await mkdtemp(path.join(tmpdir(), "pocket-bare-installer-"));

    t.after(() => rm(bare, { recursive: true, force: true }));
    await mkdir(path.join(bare, "scripts"));

    for (const name of [
      "install.mjs",
      "install-runtime.mjs",
      "install-release.mjs",
      "install-commands.mjs",
      "install-files.mjs",
      "install-launchd.mjs",
      "setup-env.ts",
    ]) {
      await cp(path.resolve("scripts", name), path.join(bare, "scripts", name));
    }

    const result = spawnSync(process.execPath, [path.join(bare, "scripts/install.mjs"), "--yes"], {
      cwd: bare,
      encoding: "utf8",
      env: { ...process.env, HOME: bare, POCKET_ORIGIN: "not-a-url", POCKET_PORT: "3000" },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pocket installation stopped: Use a complete HTTPS address/);
  }
);
