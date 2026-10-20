import { mkdtemp, rm } from "node:fs/promises";
import { DelegationStore } from "../src/server/delegations";
import { type SpinnerLibrary } from "../src/lib/spinner";
import assert from "node:assert/strict";
import { codexParentTools } from "../src/server/harness/mcp-config";
import os from "node:os";
import path from "node:path";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

type SpinnerConnection = Awaited<ReturnType<typeof spinnerClient>>;
const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

/**
Persists the real parent policy before creating the spinner capability fixture's child.
@param store - Private native delegation store.
@param directory - Private parent working directory.
@returns Canonical created child without parent spinner capability.
*/
function spinnerChild(store: DelegationStore, directory: string) {
  store.saveParent("spinner-fixture", { cwd: directory, policy: { sandbox: "read-only", approval: "never" } });

  return store.create("spinner-fixture", {
    title: "Fixture child",
    body: "No spinner access",
    idempotencyKey: "fixture",
  });
}

/**
Requires a native command claim before binding child-only MCP environment identities.
@param store - Private native delegation store.
@param directory - Private parent working directory.
@returns Managed child/command environment binding for the real stdio clients.
*/
function spinnerChildBinding(store: DelegationStore, directory: string) {
  const child = spinnerChild(store, directory);
  const command = store.queue.claim("spinner-fixture", child.id);

  assert.ok(command);

  return { POCKET_CHILD_ID: child.id, POCKET_COMMAND_ID: command.id };
}

/**
Requires the actual selected native asset before querying the child-only tool inventory.
@param side - Connected real child-only MCP client.
@param before - Canonical main spinner library captured before denied requests.
@returns Actual selected asset and native child tool inventory.
*/
async function childSpinnerTools(side: SpinnerConnection, before: SpinnerLibrary) {
  assert.ok(before.current);

  return { current: before.current, inventory: await side.client.listTools() };
}

/**
Checks that child, forced, unbound and native-child contexts cannot invoke main spinner operations.
@param side - Child-only MCP client that must not advertise or execute spinner tools.
@param deniedClients - Other real native clients lacking the main parent capability.
@param id - Selected canonical asset identity supplied to the delete attempt.
*/
async function assertDeniedSpinnerTools(side: SpinnerConnection, deniedClients: SpinnerConnection[], id: string) {
  for (const [name, input] of [
    ["spinner_set", { path: fixture }],
    ["spinner_reset", {}],
    ["spinner_delete", { id }],
    ["spinner_status", {}],
  ] as const) {
    await assert.rejects(side.client.callTool({ name, arguments: input }), /not found/);

    for (const denied of deniedClients) {
      const result = await denied.client.callTool({ name, arguments: input });

      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /only to the main Pocket/);
    }
  }
}

await test("child MCP calls and forced main-server invocation reject spinner capability at runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-child-"));
  const main = await spinnerClient(directory);
  const store = new DelegationStore(directory);

  const context = spinnerChildBinding(store, directory);
  const side = await spinnerClient(directory, context, "scripts/side-pocket-mcp.ts");
  const forced = await spinnerClient(directory, context);
  const nativeChild = await spinnerClient(directory, { CODEX_THREAD_ID: "native-child-session" });
  const unbound = await spinnerClient(directory, { POCKET_MAIN_THREAD_ID: "different-main" });

  try {
    const before = await main.call("spinner_set", { path: fixture });

    const { current, inventory } = await childSpinnerTools(side, before);
    const args = codexParentTools({ command: process.execPath, args: [], env: context });

    assert.deepEqual(
      inventory.tools.map((tool) => tool.name),
      ["message_parent"]
    );
    assert.ok(args.includes("mcp_servers.pocket.enabled=false"));
    assert.ok(args.includes(`mcp_servers.pocket.env.POCKET_CHILD_ID=${JSON.stringify(context.POCKET_CHILD_ID)}`));
    assert.ok(args.includes('mcp_servers.pocket.env.POCKET_MAIN_THREAD_ID=""'));

    await assertDeniedSpinnerTools(side, [forced, unbound, nativeChild], current.id);

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
