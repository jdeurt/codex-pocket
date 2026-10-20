import { type ChildProcess, fork } from "node:child_process";
import {
  type DelegationCommand,
  type SidePocket,
  delegationCommandSchema,
  sidePocketSchema,
} from "../../src/server/delegation-data";
import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { DelegationStore } from "../../src/server/delegations";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

class Peer {
  private listeners = new Set<() => void>();

  private sequence = 0;

  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  readonly events: Message[] = [];

  constructor(readonly child: ChildProcess) {
    child.on("message", (input: unknown) => {
      const message = dataSchema.parse(input);

      if (message.event) {
        this.events.push(message);
      }

      const pending = this.pending.get(Number(message.id));

      if (pending) {
        this.pending.delete(Number(message.id));

        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }

      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  call(method: "create" | "createAndCrash" | "close" | "resume" | "answerAndClose", args: Message): Promise<SidePocket>;
  call(method: "claim", args: Message): Promise<DelegationCommand | undefined>;
  call(method: string, args?: Message): Promise<unknown>;
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

  until(isSatisfied: (events: Message[]) => boolean, timeoutMs = WAIT_MS) {
    return new Promise<void>((resolve, reject) => {
      const resources: { timer?: NodeJS.Timeout } = {};
      const check = () => {
        if (!isSatisfied(this.events)) {
          return;
        }

        clearTimeout(resources.timer);
        this.listeners.delete(check);
        resolve();
      };

      resources.timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out; simulator events: ${JSON.stringify(this.events)}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  starts() {
    return this.events.filter((entry) => entry.event === "started");
  }
}

export async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-worker-flow-"));
  const store = new DelegationStore(directory);
  const peers: Peer[] = [];
  const clients: Client[] = [];

  store.saveParent(owner, { cwd: directory, policy: { sandbox: "danger-full-access", approval: "never" } });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[0] !== "CODEX_THREAD_ID" && entry[1] !== undefined
      )
    ),
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

    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
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

  t.after(async () => {
    for (const client of clients) {
      await client.close();
    }

    for (const entry of peers) {
      if (!entry.child.connected) {
        continue;
      }

      const exited = once(entry.child, "exit");

      entry.child.send({ method: "stop" });
      await exited;
    }

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { store, directory, peer, mcp };
}

export const assignment = (key: string, harness = "codex", body = key) => ({
  title: key,
  body,
  harness,
  idempotencyKey: key,
});
export const tool = async (client: Client, name: string, args: Message) => {
  const result = await client.callTool({ name, arguments: args });

  assert.equal(result.isError, undefined, JSON.stringify(result));

  return dataSchema.parse(toolJson(result));
};

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
