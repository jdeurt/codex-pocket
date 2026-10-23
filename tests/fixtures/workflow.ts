import { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Data, type Turn } from "../../src/lib/protocol";
import { CodexStore } from "../simulators/codex-store";
import { configSchema } from "../../src/server/config";
import { assertExpectedRequests } from "./unexpected-request";
import { simulatorArgs } from "../simulators/launch";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { setTimeout as poll } from "node:timers/promises";

const DEADLINE_MS = 5000;
const POLL_MS = 10;

/** Wait for an observable workflow transition with a bounded, named failure.
@param isReady - Observation of the public result or persisted state.
@param message - Behavior that must become observable.
*/
export async function eventually(isReady: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + DEADLINE_MS;

  while (!(await isReady())) {
    assert.ok(Date.now() < deadline, message);
    await poll(POLL_MS);
  }
}

/** Bind disposable application state and restore every environment variable after owned resource cleanup.
@param t - Workflow context owning this workflow’s resources.
@returns Private state directory and an environment override operation.
*/
export async function workspace(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-workflow-"));
  const resources: (() => unknown)[] = [];
  const cleanup = (close: () => unknown) => {
    resources.push(close);
  };
  const previous = new Map<string, string | undefined>();
  const environment = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (!previous.has(name)) {
        previous.set(name, process.env[name]);
      }

      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  };

  environment({
    CODEX_THREAD_ID: undefined,
    CODEX_POCKET_STATE_DIR: directory,
    CODEX_POCKET_LOG_DIR: path.join(directory, "logs"),
    OPENAI_API_KEY: undefined,
  });
  t.after(async () => {
    const failures: unknown[] = [];

    for (const close of resources.toReversed()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }

    globalThis.codexPocketSchedules?.close();
    Reflect.deleteProperty(globalThis, "codexPocketSchedules");
    environment(Object.fromEntries(previous));
    await rm(directory, { recursive: true, force: true });

    if (failures.length > 0) {
      throw new AggregateError(failures, "Workflow cleanup failed");
    }
  });

  return { directory, environment, cleanup };
}

/** Prepare native history and literal protocol inputs before the real transport starts.
@param t - Workflow context owning the private state.
@param scenario - Saved external RPC behavior, independent of Pocket's projections.
@param turns - Saved native history imported by the application on first resume.
@returns Parent identity and production launch configuration.
*/
export async function nativeWorkspace(t: TestContext, scenario: Data = {}, turns: Turn[] = []) {
  const isolated = await workspace(t);
  const state = path.join(isolated.directory, "native.sqlite");
  const script = path.join(isolated.directory, "scenario.json");
  const store = new CodexStore(state);
  const parent = store.create({ cwd: isolated.directory });

  parent.turns = structuredClone(turns);
  store.save();
  await writeFile(
    script,
    JSON.stringify({
      ...scenario,
      scripts: scenario.scripts ?? [
        {
          method: "config/read",
          result: { config: { sandbox_mode: "read-only", approval_policy: "never" }, origins: {} },
        },
      ],
    })
  );
  isolated.environment({ POCKET_SIMULATOR_STATE: state, POCKET_SIMULATOR_SCENARIO: script });
  isolated.cleanup(() => assertExpectedRequests(isolated.directory));

  return {
    ...isolated,
    parent,
    config: configSchema.parse({
      cwd: isolated.directory,
      threadId: parent.id,
      codexBinary: process.execPath,
      serverArgs: simulatorArgs,
    }),
  };
}
