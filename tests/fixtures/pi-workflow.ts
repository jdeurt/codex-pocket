import { fauxProvider } from "@earendil-works/pi-ai";
import { type TestContext } from "node:test";
import { type RpcEvent, type Turn, object, threadSchema } from "../../src/lib/protocol";
import { CodexRpc } from "../../src/server/rpc";
import { PiMain } from "../../src/server/pi-main";
import { openPiSession } from "../../src/server/pi-session";
import { nativeWorkspace, eventually } from "./workflow";
import { settleTaskIndex } from "../../src/tasks/retrieval/runtime";
import assert from "node:assert/strict";

/** Open real Pi parsing, tools and storage with the SDK's documented provider replay boundary.
@param t - Workflow context owning transports and durable state.
@param resumes - Exact number of expected session openings.
@param turns - Saved Codex history for the real Pi migration path.
@returns Production session and deterministic provider responses.
*/
export async function piWorkflow(t: TestContext, resumes = 1, turns: Turn[] = []) {
  const fixture = await nativeWorkspace(
    t,
    {
      scripts: Array.from({ length: resumes }, () => ({
        method: "config/read",
        result: { config: { sandbox_mode: "read-only", approval_policy: "never" }, origins: {} },
      })),
    },
    turns
  );
  const native = new CodexRpc();
  const provider = fauxProvider({ provider: "pocket-workflow", models: [{ id: "notes" }, { id: "review" }] });
  const configureResponses = provider.setResponses;

  let expectedProviderCalls = 0;

  provider.setResponses = (responses) => {
    assert.equal(
      provider.getPendingResponseCount(),
      0,
      "Previous replay inputs must be consumed before another scenario"
    );
    expectedProviderCalls += responses.length;
    configureResponses(responses);
  };
  const events: RpcEvent[] = [];
  const errors: unknown[] = [];
  const sessions: PiMain[] = [];
  const open: typeof openPiSession = async (...args) => {
    const opened = await openPiSession(...args);

    opened.runtime.registerNativeProvider(provider.provider);

    return { ...opened, selection: "pocket-workflow/notes" };
  };
  const create = () => {
    const main = new PiMain(
      fixture.config,
      native,
      (event) => {
        events.push(structuredClone(event));
      },
      () => Promise.resolve("synthetic-pi-key"),
      (error) => {
        errors.push(error);
      },
      open
    );

    sessions.push(main);

    return main;
  };

  fixture.cleanup(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await native.shutdown();
    await settleTaskIndex(fixture.parent.id);
    assert.deepEqual(errors, [], "Background Pi failures must fail the workflow");
    assert.equal(provider.getPendingResponseCount(), 0, "All required provider inputs must be consumed");
    assert.equal(provider.state.callCount, expectedProviderCalls, "Unexpected inference calls must fail the replay");
  });
  await native.connect(fixture.config, "bare");
  const main = create();

  await main.request("thread/resume", {});
  const history = async (session = main) =>
    threadSchema.parse(
      object(
        await session.request("thread/read", {
          threadId: fixture.parent.id,
        })
      ).thread
    ).turns;
  const send = async (id: string, text: string, session = main) => {
    const start = events.length;

    await session.request("turn/start", { clientUserMessageId: id, input: [{ type: "text", text }] });
    await eventually(
      () => events.slice(start).some((event) => event.method === "turn/completed"),
      `Pi must finish ${id}`
    );

    const turn = events.slice(start).find((event) => event.method === "turn/completed")?.params.turn;

    assert.ok(turn);

    return turn;
  };

  return { ...fixture, main, create, provider, events, history, send };
}
