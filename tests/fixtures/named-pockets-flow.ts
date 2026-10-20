import {
  createPocket,
  deletePocket,
  requestBridge,
  startNamedPockets,
  stopNamedPockets,
} from "../../src/server/named-pockets";
import { getUpload, saveUpload } from "../../src/server/uploads";
import { type Bridge } from "../../src/server/bridge";
import assert from "node:assert/strict";
import { pocketStore } from "../../src/server/pocket-store";
import { readLocal } from "../../src/server/local-state";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const ARGUMENT_COUNT = 4;
const MAX_POLLS = 100;
const POLL_MS = 20;
const [phase, firstId, secondId, messageId] = z.array(z.string()).length(ARGUMENT_COUNT).parse(process.argv.slice(2));

/** Resolve a saved parent's actual production bridge.
@param id - Catalog identity created in the first process.
@returns Hydrated independent native bridge.
*/
const parent = (id: string) => requestBridge(new Request(`http://localhost:3000/api/events?pocket=${id}`));

/** Confirm both independent native parents accepted the same client receipt ID once.
@param first - First connected main Pocket.
@param second - Second connected main Pocket.
*/
function assertSeparate(first: Bridge, second: Bridge) {
  assert.notEqual(first.snapshot.threadId, second.snapshot.threadId);
  assert.match(JSON.stringify(first.snapshot.turns), /First independent task/);
  assert.doesNotMatch(JSON.stringify(first.snapshot.turns), /Second independent task/);
  assert.match(JSON.stringify(second.snapshot.turns), /Second independent task/);
  assert.doesNotMatch(JSON.stringify(second.snapshot.turns), /First independent task/);
  assert.equal(first.snapshot.turns.length, 1);
  assert.equal(second.snapshot.turns.length, 1);
}

/** Exercise the real upload store across independently configured parents.
@param first - First connected main Pocket.
@param second - Second connected main Pocket.
*/
async function isolatedUpload(first: Bridge, second: Bridge) {
  const id = crypto.randomUUID();
  const request = new Request(`http://localhost:3000/api/uploads?id=${id}&name=notes.txt&type=text/plain`, {
    method: "PUT",
    body: "Private to first Pocket",
    headers: { "Content-Type": "application/octet-stream" },
  });
  const firstThread = z.string().parse(first.snapshot.threadId);
  const secondThread = z.string().parse(second.snapshot.threadId);
  const file = await saveUpload(firstThread, id, request);

  assert.equal(file.id, id);
  await assert.rejects(getUpload(secondThread, id));
  await assert.doesNotReject(getUpload(firstThread, id));
}

/**
Send through production bridges and require independent durable receipts.
*/
async function sendSeparate() {
  const first = await parent(firstId);
  const second = await parent(secondId);
  const replies = await Promise.all([
    first.send(messageId, "First independent task"),
    second.send(messageId, "Second independent task"),
  ]);
  const firstReceipt = JSON.stringify(await readLocal(`pockets/${firstId}/outbox.json`, null));
  const secondReceipt = JSON.stringify(await readLocal(`pockets/${secondId}/outbox.json`, null));

  assert.deepEqual(
    replies.map((entry) => entry.status),
    ["sent", "sent"]
  );
  assertSeparate(first, second);
  assert.match(firstReceipt, /First independent task/);
  assert.doesNotMatch(firstReceipt, /Second independent task/);
  assert.match(secondReceipt, /Second independent task/);
  await isolatedUpload(first, second);
  await assert.rejects(deletePocket(firstId), /still has work/);
  pocketStore().rename(secondId, "Writing notes");
}

/**
Create named parents and persist held native work before this host process exits.
*/
async function initialFlow() {
  await createPocket(firstId, "Research");
  await createPocket(secondId, "Writing");
  await sendSeparate();
}

/** Stop a held simulated turn through the production native protocol boundary.
@param bridge - Independently hydrated native connection.
*/
async function interrupt(bridge: Bridge) {
  await bridge
    .agentReader()
    .request("turn/interrupt", { threadId: bridge.snapshot.threadId, turnId: bridge.snapshot.activeTurnId });

  for (let attempt = 0; attempt < MAX_POLLS && bridge.snapshot.activeTurnId; attempt++) {
    await setTimeout(POLL_MS);
  }

  assert.equal(bridge.snapshot.activeTurnId, undefined);
}

/**
Rehydrate in a fresh host process without replay, then delete only settled Pockets.
*/
async function recoveredFlow() {
  const first = await parent(firstId);
  const second = await parent(secondId);
  const receipt = await first.send(messageId, "First independent task");

  assertSeparate(first, second);
  assert.equal(receipt.status, "sent");
  assert.equal(pocketStore().get(secondId).name, "Writing notes");
  await assert.rejects(deletePocket(firstId), /still has work/);
  await interrupt(first);
  await deletePocket(firstId);
  await assert.rejects(parent(firstId), /no longer available/);
  assert.equal(second.snapshot.turns.length, 1);
  await interrupt(second);
  await deletePocket(secondId);
  await assert.rejects(deletePocket("main"), /last one/);
}

/**
Dispatch the requested host lifecycle phase after configuration is complete.
*/
async function run() {
  await startNamedPockets();

  if (phase === "initial") {
    await initialFlow();
  } else {
    await recoveredFlow();
  }
}

try {
  await run();
} finally {
  await stopNamedPockets();
}
