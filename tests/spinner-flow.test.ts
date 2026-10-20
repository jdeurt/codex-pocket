import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DelegationStore } from "../src/server/delegations";
import assert from "node:assert/strict";
import { codexParentTools } from "../src/server/harness/mcp-config";
import { createTonalFixtures } from "./fixtures/spinner-tonal-images";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

const DIGEST_HEX_LENGTH = 64;
const ANIMATION_FRAMES = 15;
const PERMISSION_MASK = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const TALL_WIDTH = 160;
const TALL_HEIGHT = 40;
const CORRUPT_PREFIX_BYTES = 300;
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_SPINNER_MIB = 8;
const MIN_CONTRAST = 0.5;

const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

await test("spinner tools copy local/upload paths, persist across MCP restarts, reset and delete only managed copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-flow-"));

  let main = await spinnerClient(directory);

  try {
    const spinnerLibrary1 = await main.call("spinner_status");

    assert.equal(spinnerLibrary1.current, null);
    const uploaded = path.join(
      directory,
      "uploads",
      "a".repeat(DIGEST_HEX_LENGTH),
      "00000000-0000-4000-8000-000000000001",
      "original"
    );

    await mkdir(path.dirname(uploaded), { recursive: true });
    await copyFile(fixture, uploaded);
    const bytes = await readFile(uploaded);
    const normalized = path.join(path.dirname(uploaded), "image.png");

    await sharp(bytes).png().toFile(normalized);
    const normalizedBytes = await readFile(normalized);
    const selected = await main.call("spinner_set", { path: uploaded });

    assert.ok(selected.current);
    assert.equal(selected.current.frames, ANIMATION_FRAMES);
    assert.equal(selected.current.mime, "image/gif");
    assert.equal(JSON.stringify(selected).includes(directory), false);
    assert.equal(JSON.stringify(selected).includes("original"), false);
    const id = selected.current.id;
    const managed = path.join(directory, "spinner-assets", id);

    assert.deepEqual(await readFile(managed), bytes);
    const fileInfo2 = await stat(managed);

    assert.equal(fileInfo2.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
    const fileInfo3 = await stat(path.dirname(managed));

    assert.equal(fileInfo3.mode & PERMISSION_MASK, PRIVATE_DIRECTORY_MODE);
    const selectedSpinner4 = await main.call("spinner_set", { path: fixture });

    assert.equal(selectedSpinner4.saved.length, 1);
    await main.client.close();
    main = await spinnerClient(directory);
    assert.deepEqual(await main.call("spinner_status"), selected);
    const resetSpinner5 = await main.call("spinner_reset");

    assert.equal(resetSpinner5.current, null);
    const spinnerLibrary6 = await main.call("spinner_status");

    assert.equal(spinnerLibrary6.saved.length, 1);
    await main.call("spinner_delete", { id });
    await assert.rejects(stat(managed));
    assert.deepEqual(await readFile(uploaded), bytes);
    assert.deepEqual(await readFile(normalized), normalizedBytes);
    const local = path.join(directory, "mutable-local.gif");

    await copyFile(uploaded, local);
    const second = await main.call("spinner_set", { path: local });

    assert.ok(second.current);
    await writeFile(local, "source may change after copying");
    assert.deepEqual(await readFile(path.join(directory, "spinner-assets", second.current.id)), bytes);
    const deletedSpinner7 = await main.call("spinner_delete", { id: second.current.id });

    assert.equal(deletedSpinner7.current, null);
    assert.equal(await readFile(local, "utf8"), "source may change after copying");
    assert.deepEqual(await readFile(uploaded), bytes);
    const spinnerLibrary8 = await main.call("spinner_status");

    assert.deepEqual(spinnerLibrary8.saved, []);

    for (const format of ["png", "jpeg", "webp"] as const) {
      const filename = path.join(directory, `wide.${format}`);

      await sharp({ create: { width: 160, height: 40, channels: 3, background: "red" } })
        .toFormat(format)
        .toFile(filename);
      const result = await main.call("spinner_set", { path: filename });

      assert.equal(result.current?.width, TALL_WIDTH);
      assert.equal(result.current.height, TALL_HEIGHT);
    }

    const webp = path.join(directory, "animated.webp");

    await sharp(bytes, { animated: true }).webp().toFile(webp);
    const selectedSpinner9 = await main.call("spinner_set", { path: webp });

    assert.equal(selectedSpinner9.current?.frames, ANIMATION_FRAMES);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("spinner tool flow rejects invalid, corrupt, oversized and unsafe input without changing the preference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-invalid-"));
  const main = await spinnerClient(directory);

  try {
    const before = await main.call("spinner_set", { path: fixture });
    const corrupt = path.join(directory, "corrupt.gif");
    const sourceBytes10 = await readFile(fixture);

    await writeFile(corrupt, sourceBytes10.subarray(0, CORRUPT_PREFIX_BYTES));
    const huge = path.join(directory, "oversize.gif");
    const file = await open(huge, "w");

    await file.truncate(MAX_SPINNER_MIB * MIB + 1);
    await file.close();
    const dimensions = path.join(directory, "too-wide.png");

    await sharp({ create: { width: 2049, height: 1, channels: 3, background: "red" } })
      .png()
      .toFile(dimensions);
    const svg = path.join(directory, "untrusted.svg");

    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
    const link = path.join(directory, "symlink.gif");

    await symlink(fixture, link);

    for (const filename of [
      corrupt,
      huge,
      dimensions,
      svg,
      link,
      directory,
      "/dev/zero",
      path.join(directory, "missing.gif"),
      "relative.gif",
      "https://media.tenor.com/n3OklKSZy1cAAAAj/kirbyjam.gif",
    ]) {
      const result = await main.client.callTool({ name: "spinner_set", arguments: { path: filename } });

      assert.equal(result.isError, true, filename);
      assert.equal(JSON.stringify(result).includes(directory), false);
      assert.deepEqual(await main.call("spinner_status"), before);
    }

    const badDelete = await main.client.callTool({ name: "spinner_delete", arguments: { id: fixture } });

    assert.equal(badDelete.isError, true);
    assert.deepEqual(await main.call("spinner_status"), before);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("child MCP calls and forced main-server invocation reject spinner capability at runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-child-"));
  const main = await spinnerClient(directory);
  const store = new DelegationStore(directory);

  store.saveParent("spinner-fixture", { cwd: directory, policy: { sandbox: "read-only", approval: "never" } });
  const child = store.create("spinner-fixture", {
    title: "Fixture child",
    body: "No spinner access",
    idempotencyKey: "fixture",
  });
  const command = store.claim("spinner-fixture", child.id);

  assert.ok(command);
  const context = { POCKET_CHILD_ID: child.id, POCKET_COMMAND_ID: command.id };
  const side = await spinnerClient(directory, context, "scripts/side-pocket-mcp.ts");
  const forced = await spinnerClient(directory, context);
  const nativeChild = await spinnerClient(directory, { CODEX_THREAD_ID: "native-child-session" });
  const unbound = await spinnerClient(directory, { POCKET_MAIN_THREAD_ID: "different-main" });

  try {
    const before = await main.call("spinner_set", { path: fixture });

    assert.ok(before.current);
    const toolList11 = await side.client.listTools();

    assert.deepEqual(
      toolList11.tools.map((tool) => tool.name),
      ["message_parent"]
    );
    const args = codexParentTools({ command: process.execPath, args: [], env: context });

    assert.ok(args.includes("mcp_servers.pocket.enabled=false"));
    assert.ok(args.includes(`mcp_servers.pocket.env.POCKET_CHILD_ID=${JSON.stringify(child.id)}`));
    assert.ok(args.includes('mcp_servers.pocket.env.POCKET_MAIN_THREAD_ID=""'));

    for (const [name, input] of [
      ["spinner_set", { path: fixture }],
      ["spinner_reset", {}],
      ["spinner_delete", { id: before.current.id }],
      ["spinner_status", {}],
    ] as const) {
      await assert.rejects(side.client.callTool({ name, arguments: input }), /not found/);

      for (const denied of [forced, unbound, nativeChild]) {
        const result = await denied.client.callTool({ name, arguments: input });

        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /only to the main Pocket/);
      }
    }

    assert.deepEqual(await main.call("spinner_status"), before);
  } finally {
    await Promise.all([
      main.client.close(),
      side.client.close(),
      forced.client.close(),
      unbound.client.close(),
      nativeChild.client.close(),
    ]);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("set derives one bounded persisted tone per image from visible pixels, leaving original alpha and bytes intact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-tone-"));

  let main = await spinnerClient(directory);

  try {
    const fixtures = await createTonalFixtures(directory);
    const tones = new Map<string, unknown>();

    for (const name of ["dark", "bright", "subtle", "hidden", "weighted"]) {
      const result = await main.call("spinner_set", { path: fixtures[name] });

      assert.ok(result.current?.tone);
      const { tone, id } = result.current;

      assert.equal(tone.version, 1);
      assert.ok(tone.contrast >= MIN_CONTRAST);
      assert.ok(tone.contrast <= 2);
      assert.ok(Number.isFinite(tone.brightness));
      tones.set(name, tone);
      assert.deepEqual(await readFile(path.join(directory, "spinner-assets", id)), await readFile(fixtures[name]));
    }

    assert.deepEqual(tones.get("dark"), tones.get("hidden"));
    assert.notDeepEqual(tones.get("dark"), tones.get("weighted"));
    assert.notDeepEqual(tones.get("dark"), tones.get("bright"));
    assert.notDeepEqual(tones.get("bright"), tones.get("subtle"));
    const before = await main.call("spinner_status");

    await main.client.close();
    main = await spinnerClient(directory);
    assert.deepEqual(await main.call("spinner_status"), before);
    const gif = await main.call("spinner_set", { path: fixture });

    assert.equal(gif.current?.frames, ANIMATION_FRAMES);
    assert.ok(gif.current.tone);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
