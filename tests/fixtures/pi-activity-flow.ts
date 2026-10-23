import { type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { type RpcEvent, initialSnapshot, object, threadSchema } from "../../src/lib/protocol";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CodexRpc } from "../../src/server/rpc";
import { CodexStore } from "../simulators/codex-store";
import { PiMain } from "../../src/server/pi-main";
import { checkActivityUi } from "./activity-ui";
import { openPiSession } from "../../src/server/pi-session";
import { reduceEvent } from "../../src/server/reducer";
import { simulatorConfig } from "../simulators/launch";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import assert from "node:assert/strict";
import path from "node:path";

const TIMEOUT_MS = 5000;
const POLL_MS = 10;
const LAST = -1;

/** Wait for an actual SDK or bridge boundary, with a bounded diagnostic on failure.
@param isReady - Observed execution condition.
*/
async function waitFor(isReady: () => boolean) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (!isReady()) {
    assert.ok(Date.now() < deadline, "Native Pi lifecycle did not reach the expected boundary");
    await delay(POLL_MS);
  }
}

/**
Control real SDK tools at execution boundaries while retaining native cancellation and progress.
*/
class ToolGates {
  readonly waiting = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>();
  readonly active = new Map<string, string>();
  readonly ended: string[] = [];

  /** Track authoritative execution independently of the production activity implementation.
  @param event - Real Pi SDK notification before Pocket projects it.
  */
  observe(event: AgentSessionEvent) {
    if (event.type === "tool_execution_start") {
      this.active.set(event.toolCallId, event.toolName === "read_file" ? "reading files" : "listing files");
    } else if (event.type === "tool_execution_end") {
      this.active.delete(event.toolCallId);
      this.ended.push(event.toolCallId);
    }
  }

  /** Create a native file tool that waits for the flow to release its actual invocation.
  @param name - Native tool identifier.
  @param root - Private project containing the case-sensitive test file.
  @returns Real Pi tool definition, run by the SDK's concurrent executor.
  */
  tool(name: string, root: string): ToolDefinition {
    return {
      name,
      label: name,
      description: "Inspect the private activity test project.",
      parameters: Type.Object({}),
      execute: async (id, _params, signal, update) => {
        const gate = Promise.withResolvers<undefined>();
        const abort = () => {
          gate.reject(new Error("Canceled file inspection"));
        };

        this.waiting.set(id, gate);
        signal?.addEventListener("abort", abort, { once: true });

        const execute = async () => {
          signal?.throwIfAborted();
          update?.({ content: [{ type: "text", text: "Inspecting CaseSensitive.txt" }], details: {} });
          await gate.promise;
          const files = await readdir(root);
          const text =
            name === "read_file" ? await readFile(path.join(root, "CaseSensitive.txt"), "utf8") : files.join(", ");

          return { content: [{ type: "text" as const, text }], details: {} };
        };

        try {
          return await execute();
        } finally {
          signal?.removeEventListener("abort", abort);
          this.waiting.delete(id);
        }
      },
    };
  }
}

/** Run production PiMain through real parallel execution, message projection, reducer and phone rendering.
@param root - Private project and native simulator store.
*/
export async function piActivityFlow(root: string) {
  const config = simulatorConfig(root);
  const store = new CodexStore(process.env.POCKET_SIMULATOR_STATE);
  const parent = store.create({ cwd: root });

  store.save();
  config.threadId = parent.id;
  await writeFile(path.join(root, "CaseSensitive.txt"), "Exact content");
  const native = new CodexRpc();
  const gates = new ToolGates();
  const provider = fauxProvider({ provider: "activity-offline", models: [{ id: "model" }] });
  const state = { ...structuredClone(initialSnapshot), connection: "connected" as const, threadId: parent.id };
  const samples: { event: RpcEvent; expected: string; actual: string | undefined }[] = [];
  const errors: unknown[] = [];
  const factory: typeof openPiSession = async (settings, rpc, params, key) => {
    const opened = await openPiSession(settings, rpc, params, key, [
      gates.tool("read_file", root),
      gates.tool("list_files", root),
    ]);

    opened.runtime.registerNativeProvider(provider.provider);
    opened.session.subscribe((event) => {
      gates.observe(event);
    });

    return { ...opened, selection: "activity-offline/model" };
  };
  const main = new PiMain(
    config,
    native,
    (event) => {
      reduceEvent(state, structuredClone(event));
      samples.push({
        event: structuredClone(event),
        expected: gates.active.values().toArray().join(", "),
        actual: visibleSnapshot(state).activity,
      });
    },
    () => Promise.resolve("offline-placeholder"),
    (error) => {
      errors.push(error);
    },
    factory
  );
  const send = async () => {
    await main.request("turn/start", {
      input: [{ type: "text", text: "Inspect the files" }],
      clientUserMessageId: crypto.randomUUID(),
    });
  };
  const check = async (expected: string | undefined) => {
    await checkActivityUi(visibleSnapshot(state), expected);
  };

  const verify = async () => {
    await native.connect(config, "bare");
    await main.request("thread/resume", {});
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("Inspect the files."),
          fauxToolCall("read_file", {}, { id: "first" }),
          fauxToolCall("list_files", {}, { id: "second" }),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(fauxToolCall("read_file", {}, { id: "third" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Inspected CaseSensitive.txt."),
    ]);
    await send();
    await waitFor(() => gates.waiting.size === 2);
    await check("reading files, listing files");
    gates.waiting.get("second")?.reject(new Error("Directory listing failed"));
    await waitFor(() => gates.ended.includes("second"));
    await check("reading files");
    gates.waiting.get("first")?.resolve(undefined);
    await waitFor(() => gates.waiting.has("third"));
    await check("reading files");
    gates.waiting.get("third")?.resolve(undefined);
    await waitFor(() => !state.activeTurnId);
    await check(undefined);
    assert.equal(state.turns.at(LAST)?.items.find((item) => item.id === "second")?.status, "failed");
    assert.equal(state.turns.at(LAST)?.items.find((item) => item.id === "first")?.text, "Exact content");
    assert.deepEqual(gates.ended, ["second", "first", "third"]);

    for (const sample of samples) {
      if (sample.expected) {
        assert.equal(sample.actual, sample.expected, JSON.stringify(sample.event));
      } else if (sample.event.params.item?.status === "running") {
        assert.doesNotMatch(
          sample.actual ?? "",
          /reading files|listing files/,
          "Generated tool arguments must not start execution status"
        );
      }
    }

    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", {}, { id: "cancel" }), { stopReason: "toolUse" }),
    ]);
    await send();
    await waitFor(() => gates.waiting.has("cancel"));
    await check("reading files");
    await main.request("turn/interrupt", { threadId: parent.id, turnId: state.activeTurnId });
    await waitFor(() => !state.activeTurnId);
    await check(undefined);
    assert.equal(state.turns.at(LAST)?.status, "interrupted");
    provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid activity fixture request" }),
    ]);
    await send();
    await waitFor(() => !state.activeTurnId);
    await check(undefined);
    assert.equal(state.turns.at(LAST)?.status, "failed");
    await main.close();
    const restored = new PiMain(
      config,
      native,
      () => {
        /*
        No native events are expected during restoration.
        */
      },
      () => Promise.resolve("offline-placeholder"),
      (error) => {
        errors.push(error);
      },
      factory
    );

    const verifyRestore = async () => {
      const result = object(await restored.request("thread/resume", {}));
      const thread = threadSchema.parse(result.thread);

      state.turns = thread.turns;
      state.activeTurnId = thread.turns.find((turn) => turn.status === "inProgress")?.id;
      await check(undefined);
    };

    try {
      await verifyRestore();
    } finally {
      await restored.close();
    }

    assert.deepEqual(errors, []);
  };

  try {
    await verify();
  } finally {
    for (const gate of gates.waiting.values()) {
      gate.resolve(undefined);
    }

    await main.close();
    await native.shutdown();
  }
}
