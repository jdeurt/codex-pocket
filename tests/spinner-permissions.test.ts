import { mkdtemp, rm } from "node:fs/promises";
import { DelegationStore } from "../src/server/delegations";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

await test("a main spinner selection survives a child mutation attempt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-permissions-"));
  const store = new DelegationStore(directory);
  const clients: Awaited<ReturnType<typeof spinnerClient>>[] = [];

  t.after(async () => {
    await Promise.all(clients.map((connection) => connection.client.close()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const main = await spinnerClient(directory);

  clients.push(main);

  store.saveParent("spinner-fixture", { cwd: directory, policy: { sandbox: "read-only", approval: "never" } });
  const child = store.create("spinner-fixture", {
    title: "Child work",
    body: "Keep the main spinner preference",
    idempotencyKey: "child",
  });
  const command = store.queue.claim("spinner-fixture", child.id);

  assert.ok(command);
  const side = await spinnerClient(directory, { POCKET_CHILD_ID: child.id, POCKET_COMMAND_ID: command.id });

  clients.push(side);

  const selected = await main.call("spinner_set", { path: fixture });

  assert.ok(selected.current);
  const denied = await side.client.callTool({ name: "spinner_reset", arguments: {} });

  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /only to the main Pocket/);
  assert.deepEqual(await main.call("spinner_status"), selected);
  const reset = await main.call("spinner_reset");

  assert.equal(reset.current, null);
});
