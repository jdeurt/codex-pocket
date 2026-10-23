import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type RpcEvent, initialSnapshot, object, threadSchema } from "../src/lib/protocol";
import { CodexRpc } from "../src/server/rpc";
import { CodexStore } from "./simulators/codex-store";
import { PiMain } from "../src/server/pi-main";
import assert from "node:assert/strict";
import { openPiSession } from "../src/server/pi-session";
import os from "node:os";
import path from "node:path";
import { readTaskState } from "../src/server/task-context";
import { simulatorConfig } from "./simulators/launch";
import test from "node:test";
import { reconcileDeliveries } from "../src/lib/deliveries";
import { reduceEvent } from "../src/server/reducer";
import { visibleSnapshot } from "../src/server/visible-snapshot";
import { checkPiChat } from "./fixtures/pi-chat-checks";
import { piSessionEndpoint } from "./fixtures/pi-session-endpoint";
import { checkPiCatalog, registerCatalogFixtures } from "./fixtures/pi-catalog-checks";

const FLOW_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 5000;
const EVENT_POLL_MS = 10;
const POLICY_READS = 4;
const LAST_SESSION = -1;

/** Wait for a canonical completed run while retaining all streamed bridge-facing notifications.
@param events - Captured canonical Pi events.
@param run - Parent whose settings and prompt are exercised.
@param text - Original user instruction.
@returns The completed canonical event.
*/
async function prompt(events: RpcEvent[], run: PiMain, text: string) {
  const completion = Promise.withResolvers<RpcEvent>();
  const answered = new Set<string | number>();
  const deadline = setTimeout(() => {
    completion.reject(new Error("Pi run did not complete"));
  }, COMPLETION_TIMEOUT_MS);
  const timer = setInterval(() => {
    for (const entry of events) {
      if (entry.method !== "item/tool/requestUserInput" || entry.id === undefined || answered.has(entry.id)) {
        continue;
      }

      answered.add(entry.id);
      run.respond(entry.id, { answers: { file: { answers: ["result.txt"] } } });
    }

    const event = events.findLast((entry) => entry.method === "turn/completed");

    if (event) {
      completion.resolve(event);
    }
  }, EVENT_POLL_MS);

  try {
    await run.request("turn/start", { input: [{ type: "text", text }], clientUserMessageId: "pi-user-receipt" });

    return await completion.promise;
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
  }
}

/** Verify tool execution, exact restored context, catalog validation and provider setup and execution-boundary reporting.
@param root - Private working directory.
@param main - Production Pi session owner.
@param create - Resource-tracked session constructor.
@param events - Canonical captured lifecycle events.
@param parentId - Native parent identity retained through migration.
@param native - Native policy/migration transport.
@param config - Parent configuration.
@param errors - Unexpected background errors.
@param faux - Offline native provider used for follow-up chat flows.
*/
async function verifyPi(
  root: string,
  main: PiMain,
  create: () => PiMain,
  events: RpcEvent[],
  parentId: string,
  native: CodexRpc,
  config: ReturnType<typeof simulatorConfig>,
  errors: unknown[],
  faux: ReturnType<typeof fauxProvider>
) {
  await main.request("thread/resume", {});
  await checkPiCatalog(main, config.allowedOrigins[0], root, parentId);
  const completion = await prompt(events, main, "Write the exact result in result.txt");

  assert.equal(completion.params.turn?.status, "completed");
  assert.equal(await readFile(path.join(root, "result.txt"), "utf8"), "Exact Pi tool result ✓");
  assert.ok(events.some((event) => event.params.item?.type === "toolTrace"));
  const tools = completion.params.turn.items.filter((item) => item.type === "toolTrace");

  assert.deepEqual(tools.find((item) => item.tool === "bash")?.toolLabels, ["Executed pwd"]);
  assert.deepEqual(tools.find((item) => item.tool === "edit")?.toolLabels, ["Edited result.txt"]);
  assert.ok(events.some((event) => event.params.item?.id === "pi-user-receipt"));
  const state = { ...structuredClone(initialSnapshot), threadId: parentId };
  const activities = new Set<string | undefined>();

  for (const event of events) {
    reduceEvent(state, structuredClone(event));
    activities.add(visibleSnapshot(state).activity);
  }

  const delivered = reconcileDeliveries(visibleSnapshot(state), [
    { id: "pi-user-receipt", text: "Write the exact result in result.txt", status: "sent" },
  ]);

  assert.deepEqual(
    {
      duplicateBubbles: delivered.state.queue.length,
      callingTools: activities.has("calling tools"),
      runningCommands: activities.has("running commands"),
      editingFiles: activities.has("editing files"),
      activeAfterCompletion: state.activeTurnId,
    },
    {
      duplicateBubbles: 0,
      callingTools: true,
      runningCommands: true,
      editingFiles: true,
      activeAfterCompletion: undefined,
    }
  );
  const mcpResults = events.filter((event) => event.params.item?.tool === "mcp__pocket__side_pocket_list");

  assert.ok(mcpResults.some((event) => event.params.item?.status === "completed"));
  assert.ok(events.some((event) => event.method === "item/tool/requestUserInput"));
  assert.ok(events.some((event) => event.method === "serverRequest/resolved"));
  const catalog = await main.request("pocket/models", {});

  assert.match(JSON.stringify(catalog), /pocket-offline\/calendar-model/);
  await assert.rejects(main.request("thread/settings/update", { model: "invented/unknown" }), /Unknown Pi model/);
  await main.close();
  const resumed = create();

  await resumed.request("thread/resume", {});
  const history = await resumed.request("thread/read", { threadId: parentId });
  const saved = threadSchema.parse(object(history).thread).turns.flatMap((turn) => turn.items);

  assert.deepEqual(saved.find((item) => item.tool === "bash")?.toolLabels, ["Executed pwd"]);
  assert.deepEqual(saved.find((item) => item.tool === "edit")?.toolLabels, ["Edited result.txt"]);

  assert.match(JSON.stringify(history), /The result is ready/);
  const active = await readTaskState(parentId);

  assert.equal(active.messages.length, 1);
  assert.equal(active.messages[0].text, "Write the exact result in result.txt");
  assert.ok(active.messages[0].entries.some((entry) => entry.role === "toolResult"));
  await checkPiChat({ main: resumed, events, faux, parentId, root, create });
  const rejected = new PiMain(
    config,
    native,
    () => {
      /*
        No provider run starts on rejected access.
        */
    },
    () => Promise.resolve(null),
    () => {
      /*
        No provider run starts on rejected access.
        */
    }
  );

  await assert.rejects(rejected.request("thread/resume", {}), /API key/);
  await resumed.close();
  const restricted = new PiMain(
    config,
    native,
    () => {
      /*
      No inference is started.
      */
    },
    () => Promise.resolve("unused-placeholder"),
    () => {
      /*
      No provider errors are expected.
      */
    }
  );

  try {
    const inspection = object(await restricted.request("thread/resume", {}));
    const profile = object(inspection.nativeDelegationProfile);

    assert.equal(profile.sandbox, "workspace-write");
    assert.match(String(object(inspection.thread).executionBoundary), /Host process permissions/);
    assert.equal(inspection.sandbox, undefined);
  } finally {
    await restricted.close();
  }

  assert.deepEqual(errors, []);
  assert.ok(object(history).thread);
}

/** Run the actual Pi SDK tool loop against its native faux provider and the production Pocket MCP.
@param root - Private host and native simulator state.
*/
async function piFlow(root: string) {
  const config = simulatorConfig(root);
  const store = new CodexStore(process.env.POCKET_SIMULATOR_STATE);
  const parent = store.create({ cwd: root });

  config.threadId = parent.id;
  store.save();
  const native = new CodexRpc();
  const events: RpcEvent[] = [];
  const errors: unknown[] = [];
  const nativePhases = new Set<string>();
  const faux = fauxProvider({ provider: "pocket-offline", models: [{ id: "calendar-model" }, { id: "second-model" }] });

  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_user_input", {
        questions: [{ id: "file", question: "Which output file?", options: [{ label: "result.txt" }] }],
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxToolCall("mcp__pocket__side_pocket_list", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "Pi tool draft" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxToolCall("edit", {
        path: "result.txt",
        oldText: "Pi tool draft",
        newText: "Exact Pi tool result ✓",
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("The result is ready."),
  ]);
  const factory: typeof openPiSession = async (...args) => {
    const opened = await openPiSession(...args);

    opened.runtime.registerNativeProvider(faux.provider);
    registerCatalogFixtures(opened.runtime);
    opened.session.subscribe((event) => {
      nativePhases.add(event.type);
    });

    return { ...opened, selection: "pocket-offline/calendar-model" };
  };
  const sessions: PiMain[] = [];
  const create = () => {
    const session = new PiMain(
      config,
      native,
      (event) => {
        events.push(structuredClone(event));
      },
      () => Promise.resolve("offline-placeholder-key"),
      (error) => {
        errors.push(error);
      },
      factory
    );

    sessions.push(session);

    return session;
  };
  const main = create();
  const endpoint = await piSessionEndpoint(() => sessions.at(LAST_SESSION));

  config.allowedOrigins = [endpoint.origin];

  try {
    await native.connect(config, "bare");
    await verifyPi(root, main, create, events, parent.id, native, config, errors, faux);

    assert.deepEqual(
      ["tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start"].filter(
        (phase) => !nativePhases.has(phase)
      ),
      [],
      "The real SDK must exercise tool start/progress/end and provider retries"
    );
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await native.shutdown();
    endpoint.server.close();
  }
}

await test(
  "Pi main executes native tools, restores source history and reports the host execution boundary independently of Codex profiles",
  {
    timeout: FLOW_TIMEOUT_MS,
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-pi-flow-"));
    const environment = {
      CODEX_POCKET_STATE_DIR: root,
      POCKET_SIMULATOR_STATE: path.join(root, "native.sqlite"),
      POCKET_SIMULATOR_SCENARIO: path.join(root, "scenario.json"),
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    const policy = { sandbox_mode: "danger-full-access", approval_policy: "never" };

    Object.assign(process.env, environment);
    await writeFile(
      environment.POCKET_SIMULATOR_SCENARIO,
      JSON.stringify({
        scripts: [
          ...Array.from({ length: POLICY_READS }, () => ({
            method: "config/read",
            result: { config: policy, origins: {} },
          })),
          { method: "config/read", result: { config: { ...policy, sandbox_mode: "workspace-write" }, origins: {} } },
        ],
      })
    );

    try {
      await piFlow(root);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }

      await rm(root, { recursive: true, force: true });
    }
  }
);
