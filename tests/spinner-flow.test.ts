/* eslint-disable unicorn/no-await-expression-member -- Flow assertions inspect sequential tool and filesystem results inline. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- Flow assertions use explicit fixture dimensions, timings and HTTP statuses. */
import { copyFile, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DelegationStore } from "../src/server/delegations";
import assert from "node:assert/strict";
import { codexParentTools } from "../src/server/harness/mcp-config";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

test("spinner tools copy local/upload paths, persist across MCP restarts, reset and delete only managed copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-flow-"));
  let main = await spinnerClient(directory);

  try {
    assert.equal((await main.call("spinner_status")).current, null);
    const uploaded = path.join(directory, "an-upload-with-sensitive-name.gif");
    await copyFile(fixture, uploaded);
    const bytes = await readFile(uploaded);
    const selected = await main.call("spinner_set", { path: uploaded });
    assert.ok(selected.current);
    assert.equal(selected.current.frames, 15);
    assert.equal(selected.current.mime, "image/gif");
    assert.equal(JSON.stringify(selected).includes(directory), false);
    assert.equal(JSON.stringify(selected).includes("sensitive"), false);
    const id = selected.current.id;
    const managed = path.join(directory, "spinner-assets", id);
    assert.deepEqual(await readFile(managed), bytes);
    assert.equal((await stat(managed)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(managed))).mode & 0o777, 0o700);
    assert.equal((await main.call("spinner_set", { path: fixture })).saved.length, 1);
    await main.client.close();
    main = await spinnerClient(directory);
    assert.deepEqual(await main.call("spinner_status"), selected);
    assert.equal((await main.call("spinner_reset")).current, null);
    assert.equal((await main.call("spinner_status")).saved.length, 1);
    await main.call("spinner_delete", { id });
    await assert.rejects(stat(managed));
    assert.deepEqual(await readFile(uploaded), bytes);
    const second = await main.call("spinner_set", { path: uploaded });
    assert.ok(second.current);
    await writeFile(uploaded, "source may change after copying");
    assert.deepEqual(await readFile(path.join(directory, "spinner-assets", second.current.id)), bytes);
    assert.equal((await main.call("spinner_delete", { id: second.current.id })).current, null);
    assert.equal(await readFile(uploaded, "utf8"), "source may change after copying");
    assert.deepEqual((await main.call("spinner_status")).saved, []);

    for (const format of ["png", "jpeg", "webp"] as const) {
      const filename = path.join(directory, `wide.${format}`);
      await sharp({ create: { width: 160, height: 40, channels: 3, background: "red" } })
        .toFormat(format)
        .toFile(filename);
      const result = await main.call("spinner_set", { path: filename });
      assert.equal(result.current?.width, 160);
      assert.equal(result.current?.height, 40);
    }

    const webp = path.join(directory, "animated.webp");
    await sharp(bytes, { animated: true }).webp().toFile(webp);
    assert.equal((await main.call("spinner_set", { path: webp })).current?.frames, 15);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("spinner tool flow rejects invalid, corrupt, oversized and unsafe input without changing the preference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-invalid-"));
  const main = await spinnerClient(directory);

  try {
    const before = await main.call("spinner_set", { path: fixture });
    const corrupt = path.join(directory, "corrupt.gif");
    await writeFile(corrupt, (await readFile(fixture)).subarray(0, 300));
    const huge = path.join(directory, "oversize.gif");
    const file = await open(huge, "w");
    await file.truncate(8 * 1024 * 1024 + 1);
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

test("child MCP calls and forced main-server invocation reject spinner capability at runtime", async () => {
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
    assert.deepEqual(
      (await side.client.listTools()).tools.map((tool) => tool.name),
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
