import { type Data, type Item, type Turn } from "../../src/lib/protocol";
import { Bridge } from "../../src/server/bridge-session";
import { CodexStore } from "../simulators/codex-store";
import { checkActivityUi } from "./activity-ui";
import { projectAgentTranscript } from "../../src/server/agent-projection";
import { simulatorConfig } from "../simulators/launch";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const TURN_ID = "activity-turn";
const EMPTY_MODELS = { data: [], nextCursor: null };
const read: Item = {
  id: "read-1",
  type: "commandExecution",
  status: "inProgress",
  command: "cat CaseSensitive.txt",
  cwd: "/fixture",
  processId: null,
  commandActions: [
    { type: "read", command: "cat CaseSensitive.txt", name: "CaseSensitive.txt", path: "CaseSensitive.txt" },
  ],
  aggregatedOutput: "",
  exitCode: null,
  durationMs: null,
};
const search: Item = {
  ...read,
  id: "search-2",
  command: "rg needle .",
  commandActions: [{ type: "search", command: "rg needle .", query: "needle", path: "." }],
};

/** Describe native execution and interleaved reasoning/token notifications through the real transport.
@param threadId - Saved simulator parent identity.
@returns Wire notifications paired with their required phone activity.
*/
function steps(threadId: string) {
  const event = (method: string, params: Data, expected: string | undefined) => ({
    method,
    params: { threadId, turnId: TURN_ID, ...params },
    expected,
  });
  const item = (method: string, value: Item, expected: string) =>
    event(method, { item: value, startedAtMs: 0, completedAtMs: 0 }, expected);

  return [
    item("item/started", read, "reading files"),
    item("item/started", search, "reading files, searching files"),
    event(
      "item/reasoning/textDelta",
      { itemId: "reason", contentIndex: 0, delta: "Considering next steps" },
      "reading files, searching files"
    ),
    event(
      "item/agentMessage/delta",
      { itemId: "comment", delta: "Still inspecting files" },
      "reading files, searching files"
    ),
    item("item/completed", { ...search, status: "failed", exitCode: 1 }, "reading files"),
    event(
      "item/commandExecution/outputDelta",
      { itemId: search.id, delta: "Late output from completed search" },
      "reading files"
    ),
    event(
      "item/reasoning/textDelta",
      { itemId: "reason", contentIndex: 0, delta: "Thinking alongside the remaining call" },
      "reading files"
    ),
    item("item/completed", { ...read, status: "completed", exitCode: 0 }, "considering options"),
    event(
      "item/reasoning/textDelta",
      { itemId: "reason", contentIndex: 0, delta: "Reasoning resumes" },
      "considering options"
    ),
    item("item/completed", { id: "reason", type: "reasoning", summary: [], content: [] }, ""),
    item("item/started", { ...read, id: "read-3" }, "reading files"),
    event(
      "error",
      { error: { message: "Temporary interruption", codexErrorInfo: null, additionalDetails: null }, willRetry: true },
      "reading files"
    ),
    event(
      "error",
      {
        error: { message: "Fatal interruption", codexErrorInfo: null, additionalDetails: null },
        willRetry: false,
      },
      ""
    ),
    event("turn/completed", { turn: { id: TURN_ID, status: "failed", items: [], error: null } }, undefined),
  ];
}

/** Drive the actual Bridge and render every native execution phase, including a transport reconnect.
@param root - Isolated native storage and working directory.
*/
export async function codexActivityFlow(root: string) {
  const store = new CodexStore(process.env.POCKET_SIMULATOR_STATE);
  const parent = store.create({ cwd: root });
  const config = { ...simulatorConfig(root), threadId: parent.id };
  const turn: Turn = { id: TURN_ID, status: "inProgress", items: [], error: null };
  const phases = steps(parent.id);
  const scenario = {
    scripts: [
      {
        method: "config/read",
        result: { config: { sandbox_mode: "read-only", approval_policy: "never" }, origins: {} },
      },
      {
        method: "turn/start",
        result: { turn },
        before: [{ method: "turn/started", params: { threadId: parent.id, turn } }],
      },
      ...phases.map(({ expected: _expected, ...event }) => ({
        method: "model/list",
        result: EMPTY_MODELS,
        before: [event],
      })),
    ],
  };

  store.save();
  await writeFile(process.env.POCKET_SIMULATOR_SCENARIO ?? "", JSON.stringify(scenario));
  const bridge = new Bridge(config);
  const verify = async () => {
    await bridge.ensureConnected();
    await bridge.send("activity-user", "Inspect files and summarize");
    const rpc = bridge.agentReader();

    for (const phase of phases) {
      await rpc.request("model/list");
      await checkActivityUi(visibleSnapshot(bridge.snapshot), phase.expected);
    }

    // Native read reconciliation must use the replacement history, not the old invocation map.
    parent.turns = [{ ...turn, items: [read, search] }];
    store.save();
    await rpc.shutdown();
    await checkActivityUi(visibleSnapshot(bridge.snapshot), undefined);
    await bridge.ensureConnected();
    await checkActivityUi(visibleSnapshot(bridge.snapshot), "reading files, searching files");
    const child = projectAgentTranscript(
      {
        agent: {
          id: "codex-child",
          parentId: parent.id,
          name: "File inspector",
          source: "native",
          harness: "codex",
          status: "running",
          preview: "",
        },
        cwd: root,
        turns: bridge.snapshot.turns,
      },
      "codex-child"
    );

    await checkActivityUi(child.state, "reading files, searching files");
    assert.equal(bridge.snapshot.turns[0].items[0].command, "cat CaseSensitive.txt");
    await bridge.agentReader().shutdown();
    await checkActivityUi(visibleSnapshot(bridge.snapshot), undefined);
    parent.turns = [{ ...turn, items: [read, { ...search, status: "completed" }] }];
    store.save();
    await bridge.ensureConnected();
    await checkActivityUi(visibleSnapshot(bridge.snapshot), "reading files");
    await bridge.agentReader().request("turn/interrupt", { threadId: parent.id, turnId: TURN_ID });
    await checkActivityUi(visibleSnapshot(bridge.snapshot), undefined);
    await bridge.agentReader().shutdown();
    parent.turns = [{ ...turn, status: "interrupted", items: [read] }];
    store.save();
    await bridge.ensureConnected();
    await checkActivityUi(visibleSnapshot(bridge.snapshot), undefined);
  };

  try {
    await verify();
  } finally {
    bridge.close();
  }
}
