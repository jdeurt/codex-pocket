import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { installLauncher, installPath, selectRelease } from "../scripts/install-commands.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { pocketCommand } from "../scripts/pocket.mjs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

const USER_ID = 501;
const TARGET = `gui/${String(USER_ID)}/dev.pocket.web`;

for (const isLoaded of [true, false]) {
  for (const command of ["start", "stop", "restart"]) {
    await test(`${command} handles a ${isLoaded ? "loaded" : "stopped"} service`, () => {
      const calls: string[][] = [];
      const status = pocketCommand(
        [command],
        (binary, args) => {
          assert.equal(binary, "/bin/launchctl");
          calls.push(args);

          return { status: !isLoaded && args[0] === "print" ? 1 : 0 };
        },
        "/home/test",
        USER_ID
      );

      assert.equal(status, 0);
      assert.deepEqual(calls[0], ["print", TARGET]);

      if ((command === "start" && isLoaded) || (command === "stop" && !isLoaded)) {
        assert.equal(calls.length, 1);
      } else if (command === "stop") {
        assert.deepEqual(calls[1], ["bootout", TARGET]);
      } else {
        assert.deepEqual(
          calls[1],
          isLoaded
            ? ["kickstart", "-k", TARGET]
            : ["bootstrap", `gui/${String(USER_ID)}`, "/home/test/Library/LaunchAgents/dev.pocket.web.plist"]
        );
      }
    });
  }
}

await test("update runs the accepted bootstrap and forwards failure without launching anything else", () => {
  const calls: string[][] = [];
  const failure = 7;
  const status = pocketCommand(
    ["update"],
    (binary, args) => {
      calls.push([binary, ...args]);

      return { status: failure };
    },
    "/home/test",
    USER_ID
  );

  assert.equal(status, failure);
  assert.deepEqual(calls, [["/bin/bash", "/home/test/.pocket/current/install.sh", "--yes"]]);
});

await test("invalid commands do not invoke the service manager", () => {
  assert.equal(
    pocketCommand(["delete"], () => assert.fail("unexpected subprocess"), "/home/test", USER_ID),
    1
  );
  assert.equal(
    pocketCommand(["start", "extra"], () => assert.fail("unexpected subprocess"), "/home/test", USER_ID),
    1
  );
});

for (const shell of ["zsh", "bash"]) {
  await test(`PATH setup preserves ${shell} settings and is idempotent`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pocket-path-"));
    const file = path.join(home, shell === "zsh" ? ".zshrc" : ".bash_profile");

    try {
      await writeFile(file, "export EXISTING_SETTING=keep\n");
      await installPath(home, `/bin/${shell}`);
      await installPath(home, `/bin/${shell}`);
      assert.equal(
        await readFile(file, "utf8"),
        'export EXISTING_SETTING=keep\n\n# Pocket commands\nexport PATH="$HOME/.pocket/bin:$PATH"\n'
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

await test(
  "installed launcher resolves the accepted release and forwards update failures",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "pocket-launcher-"));
    const home = path.join(userHome, ".pocket");
    const release = path.join(home, "releases/accepted");
    const failure = 7;

    try {
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
    } finally {
      await rm(userHome, { recursive: true, force: true });
    }
  }
);
