import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    '#!/bin/sh\nif [ "$1" = -e ]; then exit 0; fi\ncat "$HOME/.pocket/source/revision" > "$HOME/launched-revision"\n'
  );
  await writeFile(path.join(runtime, "npm"), "#!/bin/sh\nexit 0\n");

  for (const file of [shim, node, path.join(runtime, "npm")]) {
    await chmod(file, EXECUTABLE_MODE);
  }

  return { remote, bin };
}

await test(
  "bootstrap clones and updates main from any directory and refuses dirty managed source",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pocket-bootstrap-"));

    await (async () => {
      const { remote, bin } = await bootstrapFixture(home);
      const run = () =>
        execFileSync("/bin/bash", [installer, "--yes"], {
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

      run();
      assert.equal(await readFile(path.join(home, "launched-revision"), "utf8"), "first");
      await writeFile(path.join(remote, "revision"), "second");
      git(remote, ["add", "."]);
      git(remote, ["commit", "-m", "second"]);
      run();
      assert.equal(await readFile(path.join(home, "launched-revision"), "utf8"), "second");
      await writeFile(path.join(home, ".pocket/source/revision"), "local edit");
      assert.throws(run, /local changes/);
      assert.equal(await readFile(path.join(home, ".pocket/source/revision"), "utf8"), "local edit");
      await assert.rejects(readFile(path.join(home, ".pocket/bootstrap.lock")), { code: "ENOENT" });
    })().finally(async () => {
      await rm(home, { recursive: true, force: true });
    });
  }
);
