import { initialSnapshot } from "../../src/lib/protocol";
import { delegations } from "../../src/server/delegations";
import { piWorkflow } from "../fixtures/pi-workflow";
import { checkReportProjection, forwardReport } from "../fixtures/pi-report-checks";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import test from "node:test";
import assert from "node:assert/strict";

await test("a completed Side Pocket report reaches the parent once as full content beside its original report", async (t) => {
  const flow = await piWorkflow(t);
  const store = delegations();

  store.saveParent(flow.parent.id, { cwd: flow.directory, policy: { sandbox: "read-only", approval: "never" } });
  const child = store.create(flow.parent.id, {
    title: "Short story",
    body: "Write a short story.",
    idempotencyKey: "story",
  });
  const command = store.queue.claim(flow.parent.id, child.id);

  assert.ok(command);
  const story =
    "Ground Clearance\n\nThe dragon arrived carrying the learner car.\n\n“Keep the wheels down.”\n\nThe end. ✓";
  const report = store.mail.message(child.id, command.id, { message: story });

  store.queue.finish(command, "completed", JSON.stringify({ status: "completed" }));
  const state = { ...structuredClone(initialSnapshot), threadId: flow.parent.id };

  await forwardReport(
    {
      parentId: flow.parent.id,
      root: flow.directory,
      faux: flow.provider,
      send: (id, body) => flow.send(id, body),
    },
    state,
    report.id,
    story
  );
  const turns = await flow.history();
  const visible = visibleSnapshot({ ...state, turns }, { reports: store.reports.list(flow.parent.id) });

  checkReportProjection(visible, report.id, story);
  assert.equal(turns.length, 1);
  assert.equal(store.mail.pending(flow.parent.id).length, 0);
});
