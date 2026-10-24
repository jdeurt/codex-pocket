import { installRelease, withInstallLock } from "../../scripts/install-release.mjs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { tmpdir } from "node:os";

/** Create an existing installation with distinguishable live assets and private data.
@param t - Owns the temporary installation through test teardown.
@returns Temporary checkout and its original content.
*/
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pocket-installer-"));

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const name of ["data", ".next", "node_modules", "src", "checkout"]) {
    await mkdir(path.join(root, name));
  }

  await writeFile(path.join(root, ".env.local"), "CODEX_THREAD_ID=original\n");
  await writeFile(path.join(root, "data/outbox.json"), "durable delivery");
  await writeFile(path.join(root, ".next/BUILD_ID"), "old-build");
  await writeFile(path.join(root, "node_modules/live.txt"), "old dependency");
  await mkdir(path.join(root, "checkout/src"));
  await writeFile(path.join(root, "checkout/src/page.ts"), "candidate source");
  await writeFile(path.join(root, "checkout/.env.local"), "stale checkout settings");

  return realpath(root);
}

/** Verify the old runtime and durable delivery data survive candidate failure.
@param root - Fixture checkout.
*/
async function unchanged(root: string) {
  assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "CODEX_THREAD_ID=original\n");
  assert.equal(await readFile(path.join(root, ".next/BUILD_ID"), "utf8"), "old-build");
  assert.equal(await readFile(path.join(root, "node_modules/live.txt"), "utf8"), "old dependency");
  assert.equal(await readFile(path.join(root, "data/outbox.json"), "utf8"), "durable delivery");
}

/** Write candidate output only after proving that no previous build/dependencies were copied.
@param release - Isolated source snapshot.
*/
async function build(release: string) {
  assert.equal(await readFile(path.join(release, "src/page.ts"), "utf8"), "candidate source");
  await assert.rejects(readFile(path.join(release, "node_modules/live.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(release, ".next/BUILD_ID")), { code: "ENOENT" });
  await mkdir(path.join(release, ".next"));
  await writeFile(path.join(release, ".next/BUILD_ID"), "new-build");
  await writeFile(path.join(release, ".env.local"), "CODEX_THREAD_ID=candidate\n");
}

/**
Fail immediately if a build failure touches the running service.
*/
function forbidden() {
  assert.fail("A failed build must never touch the service");
}

for (const failure of ["build", "missing-output"]) {
  await test(`failed ${failure} keeps the old service running and discards the candidate`, async (t) => {
    const root = await fixture(t);

    await assert.rejects(
      installRelease(
        path.join(root, "checkout"),
        root,
        async (release) => {
          await writeFile(path.join(release, ".env.local"), "candidate settings");
          await unchanged(root);

          if (failure !== "missing-output") {
            throw new Error(`Failed ${failure}`);
          }
        },
        { stop: forbidden, start: forbidden, restore: forbidden }
      )
    );
    await unchanged(root);
    assert.deepEqual(await readdir(path.join(root, "releases")), []);
  });
}

await test("successful activation stops only after build and shares the original state and config", async (t) => {
  const root = await fixture(t);
  const events: string[] = [];

  await withInstallLock(root, async () => {
    await installRelease(
      path.join(root, "checkout"),
      root,
      async (candidate) => {
        await assert.rejects(
          withInstallLock(root, async () => {
            await installRelease(path.join(root, "checkout"), root, build, {
              stop: forbidden,
              start: forbidden,
              restore: forbidden,
            });
          }),
          /Another installer/
        );
        await build(candidate);
        await unchanged(root);
        events.push("built");
      },
      {
        async stop() {
          await unchanged(root);
          events.push("stopped");
        },
        async start(candidate) {
          assert.equal(await readFile(path.join(candidate, ".next/BUILD_ID"), "utf8"), "new-build");
          assert.equal(await realpath(path.join(candidate, ".env.local")), path.join(root, ".env.local"));
          assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "CODEX_THREAD_ID=candidate\n");
          events.push("started");
        },
        restore() {
          assert.fail("A successful activation must not roll back");
        },
      }
    );
  });

  assert.deepEqual(events, ["built", "stopped", "started"]);
  assert.equal(await readFile(path.join(root, ".next/BUILD_ID"), "utf8"), "old-build");
  assert.equal(await readFile(path.join(root, "data/outbox.json"), "utf8"), "durable delivery");
});

await test("failed startup restores configuration before restarting the old service", async (t) => {
  const root = await fixture(t);
  const events: string[] = [];

  await assert.rejects(
    installRelease(path.join(root, "checkout"), root, build, {
      stop() {
        events.push("stop");
      },
      async start() {
        assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "CODEX_THREAD_ID=candidate\n");
        throw new Error("startup failed");
      },
      async restore() {
        await unchanged(root);
        events.push("restored");
      },
    }),
    /startup failed/
  );
  assert.deepEqual(events, ["stop", "stop", "restored"]);
  await unchanged(root);
  assert.deepEqual(await readdir(path.join(root, "releases")), []);
});

/** Check that failed recovery retains its candidate for manual diagnosis.
@param root - Fixture checkout.
*/
async function assertRetainedRelease(root: string) {
  const retained = await readdir(path.join(root, "releases"));

  assert.equal(retained.length, 1);
}

await test("failed recovery retains candidate files and reports both errors", async (t) => {
  const root = await fixture(t);

  await assert.rejects(
    installRelease(path.join(root, "checkout"), root, build, {
      stop: () => Promise.resolve(),
      start() {
        throw new Error("bootstrap failed");
      },
      restore() {
        throw new Error("restore failed");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);

      return true;
    }
  );
  await unchanged(root);
  await assertRetainedRelease(root);
});

await test("failed first launch removes new settings and leaves no accepted release", async (t) => {
  const root = await fixture(t);

  await rm(path.join(root, ".env.local"));
  await assert.rejects(
    installRelease(path.join(root, "checkout"), root, build, {
      stop: () => Promise.resolve(),
      start() {
        throw new Error("first launch failed");
      },
      async restore() {
        await assert.rejects(readFile(path.join(root, ".env.local")), { code: "ENOENT" });
      },
    }),
    /first launch failed/
  );
  await assert.rejects(readFile(path.join(root, "current")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(root, "releases")), []);
});
