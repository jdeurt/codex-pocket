import { formatEnvironment, saveSetupEnvironment, setupOrigin } from "../scripts/setup-env";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const modeMask = 0o777;
const privateMode = 0o600;

await test("local setup needs no remote origin, while phone origins must be canonical HTTPS addresses", () => {
  const insecure = new URL("https://example.com");

  assert.equal(setupOrigin(""), undefined);
  assert.equal(setupOrigin("  "), undefined);

  insecure.protocol = "http:";
  assert.throws(() => setupOrigin(insecure.href));
  assert.equal(setupOrigin("https://pocket.example.com/"), "https://pocket.example.com");

  for (const invalid of ["bad", "https://a/b", "https://a?b=c", "https://a/#x", "https://u:p@a"]) {
    assert.throws(() => setupOrigin(invalid));
  }
});

await test("configuration reruns keep chat identity, secrets and process settings while updating selected values", () => {
  const source = "# Keep this comment\nCODEX_THREAD_ID='saved-chat'\nSECRET_TOKEN=private-value\n";
  const values = {
    CODEX_THREAD_ID: "saved-chat",
    CODEX_CWD: "/Users/example/Folder with spaces/$project",
    CODEX_SERVER_ARGS: JSON.stringify(["app-server", "-c", 'model="chosen-model"']),
  };
  const first = formatEnvironment(source, values);

  assert.equal(formatEnvironment(first, values), first);
  assert.ok(first.includes("SECRET_TOKEN=private-value"));
  assert.ok(first.includes("# Keep this comment"));
  assert.equal(first.match(/^CODEX_THREAD_ID=/gm)?.length, 1);
  assert.ok(first.includes(String.raw`\$project`));
  assert.throws(() => formatEnvironment(first, { CODEX_THREAD_ID: "one\ntwo" }));
});

/**
Checks that repeated native setup saves retain both selected environment values.
@param file - Private environment file written by the real setup operations.
*/
async function assertRetainedEnvironment(file: string) {
  const contents = await readFile(file, "utf8");

  assert.ok(contents.includes("CODEX_THREAD_ID='saved'"));
  assert.ok(contents.includes("CODEX_CWD='/work'"));
}

/**
Checks native file permissions and neighboring queued state after setup writes complete.
@param file - Written private environment file.
@param directory - Private workflow directory containing the untouched outbox neighbor.
*/
async function assertPrivateSetup(file: string, directory: string) {
  const fileStat = await stat(file);
  const neighbors = await readdir(directory);

  assert.equal(fileStat.mode & modeMask, privateMode);
  assert.deepEqual(
    neighbors.toSorted((a, b) => a.localeCompare(b)),
    [".env.local", "outbox.json"]
  );
  assert.equal(await readFile(path.join(directory, "outbox.json"), "utf8"), "keep queued delivery");
}

await test("setup atomically writes an owner-private env file without altering neighboring state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-setup-"));
  const file = path.join(directory, ".env.local");

  try {
    await writeFile(path.join(directory, "outbox.json"), "keep queued delivery");
    await saveSetupEnvironment(file, { CODEX_THREAD_ID: "saved" });
    await saveSetupEnvironment(file, { CODEX_CWD: "/work" });
    await assertRetainedEnvironment(file);
    await assertPrivateSetup(file, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
