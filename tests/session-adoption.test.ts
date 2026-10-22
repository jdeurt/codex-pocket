import { codexOwner, ownedTurn } from "./fixtures/codex-owner";
import { inspectAdoption, sessionAttachment } from "../src/server/session-adoption";
import { AttachedCodexAdapter } from "../src/server/harness/codex-attached";
import { DelegationWorker } from "../src/server/delegation-worker";
import { type SidePocket } from "../src/server/delegations";
import { TEST_TIMEOUT_MS } from "./fixtures/delegation-flow";
import assert from "node:assert/strict";
import test from "node:test";

const LAST_CLIENT = -1;

type Owner = Awaited<ReturnType<typeof codexOwner>>;

/**
Build the real live adapter from the same durable metadata used by the production worker.
@param fixture - Isolated owning server and database.
@param child - Adopted delegate identity.
@returns Live adapter that cannot start a local Codex binary.
*/
function adapterFor(fixture: Owner, child: SidePocket) {
  return new AttachedCodexAdapter({
    config: fixture.config,
    child: { ...child, attachment: sessionAttachment(child.metadata) },
    callbacks: {
      metadata: () => {
        /*
        No persisted adapter metadata needed for this direct transport assertion.
        */
      },
      output: () => {
        /*
        Assertions read canonical native turns instead of callback output.
        */
      },
      request: () => Promise.reject(new Error("Owner handles approvals")),
    },
  });
}

/**
Inspect and adopt a real simulated session without adding native input.
@param fixture - Shared owning server.
@param threadId - Original native identity.
@returns Persisted tracked child.
*/
async function adopt(fixture: Owner, threadId: string) {
  const input = { threadId, title: "Existing work", idempotencyKey: "adopt", socketPath: fixture.socketPath };
  const session = await inspectAdoption(fixture.config, input);

  return fixture.store.adoptions.adopt("parent", input, session);
}

/**
Disconnect the observer after its read is in flight and require an explicit failed watch.
@param fixture - Shared native owner.
@param adapter - Open production attachment.
@param turnId - Existing turn being watched.
*/
async function disconnectWatch(fixture: Owner, adapter: AttachedCodexAdapter, turnId: string) {
  const result = adapter.watch(turnId);
  const rejection = assert.rejects(result, /disconnect|not connected/u);

  await adapter.history();
  fixture.clients.values().toArray().at(LAST_CLIENT)?.terminate();
  await rejection;
}

await test(
  "live adoption observes the original turn and delivers one report without another assignment",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await codexOwner(t);
    const { thread, turn } = await ownedTurn(fixture);
    const child = await adopt(fixture, thread.id);
    const delivered: string[] = [];
    const report = Promise.withResolvers<undefined>();
    const worker = new DelegationWorker(
      fixture.store,
      {
        send: (id) => {
          delivered.push(id);
          report.resolve(undefined);

          return Promise.resolve({ status: "sent" });
        },
      },
      fixture.config
    );

    t.after(() => worker.stop());
    worker.start();
    await worker.tick();
    assert.equal(fixture.store.get("parent", child.id).status, "running");
    fixture.turns.release(turn.id);
    await report.promise;
    await worker.stop();
    assert.equal(delivered.length, 1);
    assert.equal(fixture.calls.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(fixture.calls.filter((call) => call.method === "thread/start").length, 1);
    assert.equal(fixture.store.get("parent", child.id).sessionId, thread.id);
    assert.match(
      fixture.store.mail.history("parent", child.id).find((mail) => mail.kind === "completion")?.payload ?? "",
      /Original owner result/u
    );
    assert.equal(fixture.owner.running, true);
  }
);

await test("completion before subscription is recovered from history without replay", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const adapter = adapterFor(fixture, child);

  t.after(() => adapter.close());
  fixture.turns.release(turn.id);
  await adapter.open();
  assert.deepEqual(await adapter.watch(turn.id), { status: "completed", text: "Original owner result" });
  assert.equal(fixture.native.get(thread.id).turns.length, 1);
});

await test("detach leaves the owner turn running and never issues interrupt or archive", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const adapter = adapterFor(fixture, child);

  await adapter.open();
  await adapter.interrupt();
  await adapter.close();
  assert.equal(fixture.native.get(thread.id).turns[0].status, "inProgress");
  assert.equal(
    fixture.calls.some((call) => ["turn/interrupt", "thread/archive"].includes(String(call.method))),
    false
  );
  assert.equal(fixture.owner.running, true);
  fixture.turns.release(turn.id);
});

await test("live corrections target the observed turn and retain the owner policy", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const adapter = adapterFor(fixture, child);

  t.after(() => adapter.close());
  await adapter.open();
  assert.deepEqual(await adapter.steer("correction", "Keep the existing work"), {
    status: "accepted",
    turnId: turn.id,
  });
  assert.deepEqual(fixture.calls.find((call) => call.method === "thread/resume")?.params, { threadId: thread.id });
  assert.equal(fixture.native.get(thread.id).turns.length, 1);
  await assert.rejects(adapter.run("later", "Never duplicate an external active turn"), /Nothing was sent/u);
  fixture.turns.release(turn.id);
});

await test("adoption retries retain one child and reject ownership conflicts and parent cycles", async (t) => {
  const fixture = await codexOwner(t);
  const { thread } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const input = {
    threadId: thread.id,
    title: "Existing work",
    idempotencyKey: "adopt",
    socketPath: fixture.socketPath,
  };

  assert.equal(fixture.store.adoptions.existing("parent", input)?.id, child.id);
  assert.equal(
    fixture.store.adoptions.adopt("parent", input, { threadId: thread.id, cwd: fixture.directory }).id,
    child.id
  );
  assert.throws(() => fixture.store.adoptions.existing("parent", { ...input, title: "Changed" }), /different work/u);
  assert.throws(
    () =>
      fixture.store.adoptions.adopt(
        "parent",
        { ...input, idempotencyKey: "duplicate" },
        {
          threadId: thread.id,
          cwd: fixture.directory,
        }
      ),
    /already tracked/u
  );
  assert.throws(
    () =>
      fixture.store.adoptions.adopt(
        "parent",
        { ...input, threadId: "parent", idempotencyKey: "cycle" },
        {
          threadId: "parent",
          cwd: fixture.directory,
        }
      ),
    /main Pocket/u
  );
  assert.equal(fixture.store.list("parent").length, 1);
  assert.equal(fixture.store.queue.list("parent", child.id).length, 1);
});

await test("queued watch owns corrections before the worker starts", async (t) => {
  const fixture = await codexOwner(t);
  const { thread } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const correction = fixture.store.queue.send("parent", child.id, "early", "Update current work");
  const watch = fixture.store.queue.claim("parent", child.id);

  assert.equal(correction.status, "pending");
  assert.equal(correction.targetId, watch?.id);
  assert.equal(watch?.id, sessionAttachment(child.metadata)?.watchCommandId);
});

await test("explicit reconnect observes current native work after recovery without replaying unknown input", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const original = fixture.store.queue.claim("parent", child.id);

  fixture.store.recover("parent");
  assert.equal(fixture.store.get("parent", child.id).status, "unknown");
  fixture.store.adoptions.reconnect("parent", child.id, {
    threadId: thread.id,
    cwd: fixture.directory,
    turnId: turn.id,
  });
  assert.equal(
    fixture.store.queue.list("parent", child.id).find((command) => command.id === original?.id)?.status,
    "unknown"
  );
  assert.equal(fixture.store.queue.list("parent", child.id).filter((command) => command.status === "queued").length, 1);
  assert.equal(fixture.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(sessionAttachment(fixture.store.get("parent", child.id).metadata)?.turnId, turn.id);
});

await test("owner disconnect rejects an attached watch and retains the original native turn", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);
  const adapter = adapterFor(fixture, child);

  await adapter.open();
  await disconnectWatch(fixture, adapter, turn.id);
  await adapter.close();
  assert.equal(fixture.native.get(thread.id).turns.length, 1);
  assert.equal(fixture.native.get(thread.id).turns[0].status, "inProgress");
});

await test("resuming an already queued observation cannot turn its old watch into a native prompt", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const child = await adopt(fixture, thread.id);

  fixture.store.adoptions.reconnect("parent", child.id, {
    threadId: thread.id,
    cwd: fixture.directory,
    turnId: turn.id,
  });
  assert.equal(fixture.store.queue.list("parent", child.id).length, 1);
  assert.equal(
    sessionAttachment(fixture.store.get("parent", child.id).metadata)?.watchCommandId,
    sessionAttachment(child.metadata)?.watchCommandId
  );
});
