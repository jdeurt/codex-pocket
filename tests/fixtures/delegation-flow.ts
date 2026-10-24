import { type ChildProcess, fork } from "node:child_process";
import {
  type DelegationCommand,
  type SidePocket,
  delegationCommandSchema,
  sidePocketSchema,
} from "../../src/state/delegation-data";
import { type HostEvent, type HostReply, hostPacketSchema } from "./delegation-protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { DelegationStore } from "../../src/server/delegations";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { dataSchema } from "../../src/lib/protocol";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { toolJson } from "./tool-json";

export type Message = Record<string, unknown>;
export const owner = "integration-parent";
const WAIT_MS = 5000;
export const CAPACITY = 8;
export const TEST_TIMEOUT_MS = 30_000;
const SIMULATOR_RECOVERY_MS = 60_000;
export const LOST_NOTIFICATION_RECOVERY_MS = 1000;
export const LAST_INDEX = -1;
export const THREE_MORE_STARTS = 3;

/**
Owns one fake host's IPC correlation, event wakeups and diagnostic stream.
*/
export class Peer {
  private listeners = new Set<() => void>();

  private sequence = 0;

  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  readonly events: HostEvent[] = [];

  /**
  Subscribes to this owned child's native diagnostics and IPC responses.
  @param child - Fake host created by this fixture's private fork operation.
  */
  constructor(readonly child: ChildProcess) {
    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
    child.on("message", (input: unknown) => {
      const message = hostPacketSchema.parse(input);

      if ("event" in message) {
        this.events.push(message);
      } else {
        this.resolvePending(message);
      }

      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  /**
  Resolves the matching control request after recording any incoming simulator event.
  @param message - Normalized IPC record from the owned fake host.
  */
  private resolvePending(message: HostReply) {
    const id = message.id;
    const pending = id === undefined ? undefined : this.pending.get(id);

    if (id === undefined || !pending) {
      return;
    }

    this.pending.delete(message.id ?? NaN);

    if (message.error) {
      pending.reject(new Error(JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  /**
  Calls a durable child mutation and validates the returned canonical child record.
  @param method - Child creation, close, resume or answer-and-close operation.
  @param args - Domain input validated by the real durable store.
  @returns Canonical child record after the persisted operation.
  */
  call(method: "create" | "createAndCrash" | "close" | "resume" | "answerAndClose", args: Message): Promise<SidePocket>;
  /**
  Claims the oldest eligible command through the actual durable queue.
  @param method - Native simulator claim operation.
  @param args - Parent-scoped child target.
  @returns Claimed canonical command, or undefined when nothing can be claimed.
  */
  call(method: "claim", args: Message): Promise<DelegationCommand | undefined>;
  /**
  Calls a simulator control while leaving its heterogeneous response unknown.
  @param method - Native simulator operation selected by the workflow.
  @param args - Optional control fields.
  @returns Unknown control response, or rejection for a host-reported error.
  */
  call(method: string, args?: Message): Promise<unknown>;
  /**
  Correlates the IPC reply and normalizes durable child and command results by their real schemas.
  @param method - Native simulator operation selected by the workflow.
  @param args - Control or persisted domain input fields.
  @returns Validated durable result or unknown control response.
  */
  async call(method: string, args: Message = {}): Promise<unknown> {
    const id = ++this.sequence;

    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, method, args });
    });

    if (method === "claim") {
      return delegationCommandSchema.optional().parse(result);
    }

    return ["create", "createAndCrash", "close", "resume", "answerAndClose"].includes(method)
      ? sidePocketSchema.parse(result)
      : result;
  }

  /**
  Waits for recorded process events without polling and removes its wakeup subscription on settlement.
  @param isSatisfied - Predicate over recorded simulator events.
  @param timeoutMs - Maximum wait before reporting the full captured event history.
  @returns Copy of the native event journal at the moment the expected sequence arrives.
  */
  until(isSatisfied: (events: HostEvent[]) => boolean, timeoutMs = WAIT_MS) {
    return new Promise<HostEvent[]>((resolve, reject) => {
      const resources: { timer?: NodeJS.Timeout } = {};
      const check = () => {
        if (!isSatisfied(this.events)) {
          return;
        }

        clearTimeout(resources.timer);
        this.listeners.delete(check);
        resolve([...this.events]);
      };

      resources.timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out; simulator events: ${JSON.stringify(this.events)}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  /**
  Selects actual simulated command-start events in their arrival order.
  @returns Recorded native starts, including harness and command identities.
  */
  starts() {
    return this.events.filter((entry) => entry.event === "started");
  }
}

/**
Requests host shutdown and joins its native process exit.
@param entry - Still-connected fake host owned by the fixture.
@returns Completion of confirmed host exit.
*/
async function stopPeer(entry: Peer) {
  const exited = once(entry.child, "exit");

  entry.child.send({ method: "stop" });
  await exited;
}

/**
Creates durable private state and registers cleanup for every fake host and MCP client.
@param t - Native Node integration context owning cleanup after this flow.
@returns Private store and scoped native host/MCP launch operations.
*/
export async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-worker-flow-"));

  await writeFile(path.join(directory, "unexpected-native.jsonl"), "");

  const store = new DelegationStore(directory);
  const peers: Peer[] = [];
  const clients: Client[] = [];

  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[0] !== "CODEX_THREAD_ID" && entry[1] !== undefined
      )
    ),
    CODEX_THREAD_ID: "",
    CODEX_POCKET_STATE_DIR: directory,
    POCKET_THREAD_ID: owner,
    POCKET_CLAUDE_BINARY: process.execPath,
    NODE_ENV: "test" as const,
  };
  const peer = async (mode = "worker", recoveryIntervalMs = SIMULATOR_RECOVERY_MS) => {
    const child = fork(path.resolve("tests/fixtures/delegation-host.ts"), [], {
      execArgv: ["--import", "tsx"],
      env: { ...env, DELEGATION_HOST_MODE: mode, DELEGATION_RECOVERY_MS: String(recoveryIntervalMs) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    const result = new Peer(child);

    peers.push(result);
    await result.until((events) => events.some((entry) => entry.event === "ready"));

    return result;
  };
  const mcp = async (script = "scripts/mcp.ts", extra: Record<string, string> = {}) => {
    const client = new Client({ name: "delegation-flow", version: "1.0.0" });

    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", script],
        cwd: process.cwd(),
        env: { ...env, ...extra },
        stderr: "pipe",
      })
    );

    return client;
  };

  store.saveParent(owner, { cwd: directory, policy: { sandbox: "danger-full-access", approval: "never" } });

  t.after(async () => {
    for (const client of clients) {
      await client.close();
    }

    for (const entry of peers) {
      if (!entry.child.connected) {
        continue;
      }

      await stopPeer(entry);
    }

    store.close();
    const unexpected = await readFile(path.join(directory, "unexpected-native.jsonl"), "utf8");

    await rm(directory, { recursive: true, force: true });
    assert.equal(unexpected, "", `Unmatched native requests:\n${unexpected}`);
  });

  return { store, directory, peer, mcp };
}

/**
Builds a concrete idempotent assignment for a fake delegation workflow.
@param key - Stable creation key and display title.
@param harness - Native harness selected by the workflow.
@param body - Assignment text, defaulting to its creation key.
@returns Canonical assignment fields supplied to the real delegation boundary.
*/
export function assignment(key: string, harness = "codex", body = key) {
  return {
    title: key,
    body,
    harness,
    idempotencyKey: key,
  };
}

/**
Calls a managed-child lifecycle tool and validates its canonical persisted child result.
@param client - Owned real stdio MCP client.
@param name - Child creation, confirmed closure or saved-session resumption tool.
@param args - Native domain input validated by the actual MCP server.
@returns Canonical persisted child, normalized once at the tool-result boundary.
*/
export function tool(
  client: Client,
  name: "side_pocket_create" | "side_pocket_close" | "side_pocket_resume",
  args: Message
): Promise<SidePocket>;
/**
Calls a report, answer or queue tool while retaining its normalized application record.
@param client - Owned real stdio MCP client.
@param name - Other registered delegation tool name.
@param args - Native domain input validated by the actual MCP server.
@returns Application record for assertions or ignored acknowledgments.
*/
export function tool(client: Client, name: string, args: Message): Promise<Message>;
/**
Calls a real MCP tool and validates its application result as a record.
@param client - Owned native stdio MCP client.
@param name - Registered tool name.
@param args - Tool input validated by the real server's domain schema.
@returns Normalized application record; MCP errors fail the integration assertion.
*/
export async function tool(client: Client, name: string, args: Message) {
  const result = await client.callTool({ name, arguments: args });

  assert.equal(result.isError, undefined, JSON.stringify(result));

  return ["side_pocket_create", "side_pocket_close", "side_pocket_resume"].includes(name)
    ? sidePocketSchema.parse(toolJson(result))
    : dataSchema.parse(toolJson(result));
}

/**
Subscribes to real durable store notifications until the expected outcome is observed.
@param store - Private durable delegation owner.
@param isSatisfied - Predicate reading the expected persisted outcome.
@returns Completion of the expected durable transition, bounded by the fixture timeout.
*/
export function state(store: DelegationStore, isSatisfied: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const resources: { timer?: NodeJS.Timeout; unsubscribe?: () => void } = {};
    const check = () => {
      if (!isSatisfied()) {
        return;
      }

      clearTimeout(resources.timer);
      resources.unsubscribe?.();
      resolve();
    };

    resources.unsubscribe = store.subscribe(check);
    resources.timer = setTimeout(() => {
      resources.unsubscribe?.();
      reject(new Error("Persisted state did not reach expected outcome"));
    }, WAIT_MS);
    check();
  });
}
