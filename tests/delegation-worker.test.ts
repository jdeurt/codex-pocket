import {
  CAPACITY,
  LAST_INDEX,
  LOST_NOTIFICATION_RECOVERY_MS,
  type Message,
  TEST_TIMEOUT_MS,
  THREE_MORE_STARTS,
  assignment,
  fixture,
  owner,
  state,
  tool,
} from "./fixtures/delegation-flow";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSignal(filename: string) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return "missing";
  }
}

test(
  "startup drains persisted assignments in queue order, caps both harnesses at eight, and exit frees a slot immediately",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer } = await fixture(t);
    const writer = await peer("writer");
    const children: Message[] = [];

    for (let index = 0; index <= CAPACITY; index++) {
      children.push(
        await writer.call(
          "create",
          assignment(`queued-${index}`, index % 2 ? "claude" : "codex", index === 0 ? "hold-close" : `queued-${index}`)
        )
      );
    }

    const worker = await peer();
    await worker.until(() => worker.starts().length === CAPACITY);
    assert.deepEqual(
      worker.starts().map((entry) => entry.childId),
      children.slice(0, CAPACITY).map((child) => child.id)
    );
    assert.equal(store.commands(owner, String(children[CAPACITY].id))[0].status, "queued");
    await worker.call("complete", { childId: children[0].id });
    await state(store, () => store.commands(owner, String(children[0].id))[0].status === "completed");
    await worker.call("barrier");
    assert.equal(worker.starts().length, CAPACITY, "slot remains occupied until harness process exit");
    await worker.call("releaseClose", { childId: children[0].id });
    await worker.until(() => worker.starts().length === CAPACITY + 1);
    assert.equal(worker.starts().at(LAST_INDEX)?.childId, children[CAPACITY].id);
    await worker.call("barrier");
    assert.equal(new Set(worker.starts().map((entry) => entry.id)).size, CAPACITY + 1);
  }
);

test(
  "simultaneous stdio enqueue wakes dispatch, and older queued assignments precede old-child followups",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer, mcp } = await fixture(t);
    const worker = await peer();
    const client = await mcp();
    const children = await Promise.all(
      Array.from({ length: CAPACITY + 1 }, (_, index) =>
        tool(client, "side_pocket_create", assignment(`burst-${index}`))
      )
    );
    await worker.until(() => worker.starts().length === CAPACITY);
    const starts = worker.starts();
    const queued = children.find((child) => starts.every((start) => start.childId !== child.id));
    assert.ok(queued);
    const first = starts[0];
    await tool(client, "side_pocket_send", {
      id: first.childId,
      message: "followup-one",
      idempotencyKey: "followup-one",
    });
    await tool(client, "side_pocket_send", {
      id: first.childId,
      message: "followup-two",
      idempotencyKey: "followup-two",
    });
    await worker.call("complete", { childId: first.childId });
    await worker.until(() => worker.starts().length === CAPACITY + 1);
    assert.equal(worker.starts()[CAPACITY].childId, queued.id);
    await worker.call("complete", { childId: starts[1].childId });
    await worker.until(() => worker.starts().length === CAPACITY + 2);
    assert.equal(worker.starts().at(LAST_INDEX)?.text, "followup-one");
    await worker.call("complete", { childId: first.childId });
    await worker.until(() => worker.starts().length === CAPACITY + THREE_MORE_STARTS);
    assert.equal(worker.starts().at(LAST_INDEX)?.text, "followup-two");
    assert.deepEqual(
      store.commands(owner, String(first.childId)).map((command) => command.status),
      ["completed", "completed", "running"]
    );
  }
);

test(
  "cross-process child mail, requests, answers, cancellation and confirmed close wake without polling",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer, mcp } = await fixture(t);
    const worker = await peer();
    const client = await mcp();
    const child = await tool(client, "side_pocket_create", assignment("question-flow"));
    await worker.until(() => worker.starts().length === 1);
    const command = store.commands(owner, String(child.id))[0];
    const childMcp = await mcp("scripts/side-pocket-mcp.ts", {
      POCKET_CHILD_ID: String(child.id),
      POCKET_COMMAND_ID: command.id,
    });
    await tool(childMcp, "message_parent", { message: "Cross-process report" });
    await worker.until((events) =>
      events.some((entry) => entry.event === "mail" && String(entry.text).includes("Cross-process report"))
    );
    await worker.call("ask", { childId: child.id });
    await worker.until((events) =>
      events.some((entry) => entry.event === "mail" && String(entry.text).includes("request"))
    );
    const request = store.mail.requests(owner, String(child.id))[0];
    await tool(client, "side_pocket_answer", {
      id: child.id,
      requestId: request.id,
      answer: { answers: { color: "Blue" } },
    });
    await worker.until((events) => events.some((entry) => entry.event === "answer"));
    assert.equal(store.get(owner, String(child.id)).status, "running");
    await worker.call("ask", { childId: child.id });
    await state(store, () => store.mail.requests(owner, String(child.id)).length === 2);
    await tool(client, "side_pocket_send", { id: child.id, message: "cancel queued", idempotencyKey: "cancel" });
    const closed = await tool(client, "side_pocket_close", { id: child.id });
    assert.equal(closed.status, "closed");
    await worker.until((events) => events.some((entry) => entry.event === "cancelled"));
    assert.deepEqual(
      store.commands(owner, String(child.id)).map((entry) => entry.status),
      ["cancelled", "cancelled"]
    );
    assert.equal(store.mail.requests(owner, String(child.id))[1].status, "cancelled");
    await tool(client, "side_pocket_resume", { id: child.id });
    await tool(client, "side_pocket_send", { id: child.id, message: "resumed", idempotencyKey: "resumed" });
    await worker.until(() => worker.starts().length === 2);
    assert.equal(store.get(owner, String(child.id)).sessionId, `saved:${String(child.id)}`);
    await worker.call("ask", { childId: child.id });
    await state(store, () => store.mail.requests(owner, String(child.id)).length === THREE_MORE_STARTS);
    const writer = await peer("writer");
    await writer.call("answerAndClose", {
      childId: child.id,
      requestId: store.mail.requests(owner, String(child.id)).at(LAST_INDEX)?.id,
      answer: { answers: { color: "Blue" } },
    });
    await state(store, () => store.get(owner, String(child.id)).status === "closed");
    assert.equal(store.commands(owner, String(child.id)).at(LAST_INDEX)?.status, "cancelled");
  }
);

test(
  "worker crash marks in-flight work unknown, retains mail IDs, and never automatically replays it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer } = await fixture(t);
    const writer = await peer("writer");
    const child = await writer.call("create", assignment("crash"));
    const worker = await peer();
    await worker.until(() => worker.starts().length === 1);
    await worker.call("holdDelivery");
    await writer.call("message", {
      childId: child.id,
      commandId: worker.starts()[0].id,
      message: "Durable before crash",
    });
    await worker.until((events) => events.some((entry) => entry.event === "mail"));
    const pendingMail = store.mail.pending(owner).find((mail) => mail.kind === "message");
    assert.ok(pendingMail);
    await worker.call("ask", { childId: child.id });
    await state(store, () => store.mail.requests(owner, String(child.id)).length === 1);
    const exited = once(worker.child, "exit");
    worker.child.kill("SIGKILL");
    await exited;
    const queued = await writer.call("create", assignment("queued-during-downtime"));
    const restarted = await peer();
    await restarted.until(() => restarted.starts().length === 1);
    assert.equal(restarted.starts()[0].childId, queued.id);
    assert.equal(store.commands(owner, String(child.id))[0].status, "unknown");
    assert.equal(store.get(owner, String(child.id)).status, "unknown");
    assert.equal(store.mail.requests(owner, String(child.id))[0].status, "cancelled");
    const recovery = store.mail.history(owner, String(child.id)).find((mail) => mail.kind === "recovery");
    assert.ok(recovery);
    await restarted.until((events) => events.some((entry) => entry.event === "mail" && entry.id === recovery.id));
    await restarted.until((events) => events.some((entry) => entry.event === "mail" && entry.id === pendingMail.id));
    await writer.call("resume", { childId: child.id });
    await writer.call("send", { childId: child.id, key: "continue", body: "Continue after inspection" });
    await restarted.until(() => restarted.starts().length === 2);
    assert.equal(restarted.starts()[1].text, "Continue after inspection");
    assert.equal(store.mail.history(owner, String(child.id)).filter((mail) => mail.kind === "recovery").length, 1);
  }
);

test(
  "bounded reconciliation recovers a commit whose writer exits before publishing its notification",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, directory, peer } = await fixture(t);
    // A short recovery interval belongs only to this simulator; production is 30s.
    const worker = await peer("worker", LOST_NOTIFICATION_RECOVERY_MS);
    const writer = await peer("writer");
    const signal = path.join(directory, "delegations.notify");
    const before = await readSignal(signal);
    const exited = once(writer.child, "exit");
    const child = await writer.call("createAndCrash", assignment("lost-notification"));
    await exited;
    assert.equal(await readSignal(signal), before);
    await worker.until(() => worker.starts().length === 1);
    assert.equal(worker.starts()[0].childId, child.id);
    assert.equal(store.commands(owner, String(child.id))[0].status, "running");
  }
);

test(
  "competing process claims enforce the shared eight-child cap without duplicate starts",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer } = await fixture(t);
    const first = await peer("writer");
    const second = await peer("writer");
    const children: Message[] = [];

    for (let index = 0; index <= CAPACITY; index++) {
      children.push(await first.call("create", assignment(`contended-${index}`)));
    }

    const claims = await Promise.all(
      children.flatMap((child) => [
        first.call("claim", { childId: child.id }),
        second.call("claim", { childId: child.id }),
      ])
    );
    const claimed = claims.filter(Boolean);
    assert.equal(claimed.length, CAPACITY);
    assert.equal(new Set(claimed.map((command) => command.id)).size, CAPACITY);
    const commands = children.flatMap((child) => store.commands(owner, String(child.id)));
    assert.equal(commands.filter((command) => command.status === "running").length, CAPACITY);
  }
);

test(
  "slow parent delivery permits dispatch and answers, and unknown delivery is not retried",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer } = await fixture(t);
    const worker = await peer();
    const writer = await peer("writer");
    await worker.call("holdDelivery");
    const child = await writer.call("create", assignment("slow-mail"));
    await worker.until(() => worker.starts().length === 1);
    await writer.call("message", { childId: child.id, commandId: worker.starts()[0].id, message: "Blocked delivery" });
    await worker.until((events) => events.some((event) => event.event === "mail"));
    const next = await writer.call("create", assignment("dispatch-while-mail-waits"));
    await worker.until(() => worker.starts().length === 2);
    await worker.call("ask", { childId: next.id });
    await state(store, () => store.mail.requests(owner, String(next.id)).length === 1);
    await writer.call("answer", {
      childId: next.id,
      requestId: store.mail.requests(owner, String(next.id))[0].id,
      answer: { answers: { color: "Blue" } },
    });
    await worker.until((events) => events.some((event) => event.event === "answer"));
    await worker.call("deliveryStatus", { status: "unknown" });
    await worker.call("releaseDelivery");
    await state(store, () => store.mail.history(owner, String(child.id))[0].delivery === "unknown");
    const mailId = store.mail.history(owner, String(child.id))[0].id;
    await worker.call("barrier");
    assert.equal(worker.events.filter((event) => event.event === "mail" && event.id === mailId).length, 1);
    await worker.call("fail", { childId: child.id });
    await state(store, () => store.get(owner, String(child.id)).status === "unknown");
    assert.equal(store.commands(owner, String(child.id))[0].status, "unknown");
  }
);
