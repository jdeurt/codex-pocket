import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { installLauncher, selectRelease } from "../../scripts/install-commands.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

await test(
  "installed launcher resolves the accepted release and forwards update failures",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const userHome = await mkdtemp(path.join(tmpdir(), "pocket-launcher-"));
    const home = path.join(userHome, ".pocket");
    const release = path.join(home, "releases/accepted");
    const failure = 7;

    t.after(async () => {
      await rm(userHome, { recursive: true, force: true });
    });

    await mkdir(path.join(release, "scripts"), { recursive: true });
    await cp("scripts/pocket-cli.mjs", path.join(release, "scripts/pocket-cli.mjs"));
    await cp("scripts/pocket.mjs", path.join(release, "scripts/pocket.mjs"));
    await symlink(process.execPath, path.join(release, ".pocket-node"));
    await writeFile(path.join(release, "install.sh"), `exit ${String(failure)}\n`);
    await installLauncher(home);
    await selectRelease(home, release);
    assert.equal(
      spawnSync(path.join(home, "bin/pocket"), ["--help"], {
        env: { ...process.env, HOME: userHome },
        encoding: "utf8",
      }).stdout.trim(),
      "Usage: pocket <update|start|stop|restart> | pocket menubar <setup|remove>"
    );
    assert.equal(
      spawnSync(path.join(home, "bin/pocket"), ["update"], {
        env: { ...process.env, HOME: userHome },
      }).status,
      failure
    );
  }
);
