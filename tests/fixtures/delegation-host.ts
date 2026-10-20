import { type AdapterOptions, type Harness } from "../../src/server/harness/types";
import { type HostPacket, hostRequestSchema } from "./delegation-protocol";
import { CodexAdapter } from "../../src/server/harness/codex";
import { DelegationStore } from "../../src/server/delegations";
import { DelegationWorker } from "../../src/server/delegation-worker";
import { SimulatedAdapter } from "./delegation-adapter";
import { configSchema } from "../../src/server/config";
import { string } from "../../src/lib/protocol";
// Simulator for process-level delegation integration flows. Never loads a model.

/**
Requires explicit fake state and rejects an inherited model thread before opening storage.
@returns Private state root selected by the integration host.
*/
function privateDirectory() {
  const directory = process.env.CODEX_POCKET_STATE_DIR;

  if (!directory || process.env.CODEX_THREAD_ID) {
    throw new Error("Integration host requires private state and no inherited model thread.");
  }

  return directory;
}

const owner = "integration-parent";
const store = new DelegationStore(privateDirectory());
const adapters = new Map<string, SimulatedAdapter>();

/**
Writes a simulator event or command reply only while the owning IPC channel remains connected.
@param data - Normalized synthetic IPC record.
*/
function send(data: HostPacket) {
  if (process.connected) {
    process.send?.(data);
  }
}

/**
Register the existing process simulator for native close and completion controls.
@param harness - Simulated harness label.
@param options - Real worker callbacks bound to this fake resource.
@returns Registered simulator retaining its confirmed-exit gate.
*/
function simulatedAdapter(harness: Harness, options: AdapterOptions) {
  const adapter = new SimulatedAdapter(options, harness, send);

  adapters.set(options.child.id, adapter);

  return adapter;
}

/**
Use real native stdio in steering flows and retain the existing confirmed-exit simulator elsewhere.
@param harness - Recorded child harness selected by the flow.
@param options - Real worker callbacks and native child identity.
@returns Owned native adapter with test-only observations of real output frames.
*/
function adapterForFlow(harness: Harness, options: AdapterOptions) {
  if (process.env.DELEGATION_HOST_MODE === "native") {
    return new CodexAdapter({
      ...options,
      callbacks: {
        ...options.callbacks,
        output(text) {
          options.callbacks.output(text);
          send({
            event: "started",
            id: options.parentTools?.env.POCKET_COMMAND_ID ?? "missing",
            childId: options.child.id,
            harness,
            text,
          });
        },
      },
    });
  }

  return simulatedAdapter(harness, options);
}

const SIMULATOR_RECOVERY_MS = 60_000;
const CRASH_EXIT_CODE = 77;
const delivery: { status: string; gate?: ReturnType<typeof Promise.withResolvers<undefined>> } = { status: "sent" };

const worker = ["worker", "native"].includes(process.env.DELEGATION_HOST_MODE ?? "")
  ? new DelegationWorker(
      store,
      {
        send: async (id, text) => {
          send({ event: "mail", id, text });
          await delivery.gate?.promise;

          return { status: delivery.status };
        },
      },
      configSchema.parse({
        threadId: owner,
        cwd: process.cwd(),
        ...(process.env.DELEGATION_HOST_MODE === "native" && {
          codexBinary: process.execPath,
          serverArgs: [
            "--import",
            new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname,
            new URL("delegation-codex.ts", import.meta.url).pathname,
          ],
        }),
      }),
      {
        createAdapter: adapterForFlow,
        recoveryIntervalMs: Number(process.env.DELEGATION_RECOVERY_MS ?? SIMULATOR_RECOVERY_MS),
      }
    )
  : undefined;

/**
Normalizes the native IPC envelope once and retains unknown domain arguments for their real store schemas.
@param input - Untrusted message received from the parent test process.
@returns Decoded identity, method, argument record and optional child target.
*/
function hostRequest(input: unknown) {
  const message = hostRequestSchema.parse(input);
  const args = message.args;

  return { id: message.id, method: message.method, args, childId: string(args.childId) };
}

/**
Applies native adapter fault, question, completion and exit-release controls.
@param method - Decoded control method.
@param childId - Synthetic child identity targeted by the control.
*/
function adapterCommand(method: unknown, childId: string) {
  switch (method) {
    case "complete": {
      adapters.get(childId)?.complete();

      return;
    }

    case "fail": {
      adapters.get(childId)?.fail();

      return;
    }

    case "ask": {
      void adapters.get(childId)?.ask();

      return;
    }

    case "releaseClose": {
      adapters.get(childId)?.release();

      return;
    }

    default: {
      throw new Error(`Unexpected simulator command ${String(method)}`);
    }
  }
}

/**
Dispatches durable store operations and fake delivery controls using the real worker and persistence owners.
@param request - Normalized IPC request from the owning test process.
@returns Native operation result, or undefined for simulator controls.
*/
async function execute(request: ReturnType<typeof hostRequest>) {
  const { method, args, childId } = request;

  switch (method) {
    case "create": {
      return store.create(owner, args);
    }

    case "send": {
      return store.queue.send(owner, childId, string(args.key), string(args.body));
    }

    case "close": {
      return store.closeChild(owner, childId);
    }

    case "resume": {
      return store.resume(owner, childId);
    }

    case "answer": {
      return store.mail.answer(owner, childId, string(args.requestId), args.answer);
    }

    case "answerAndClose": {
      store.mail.answer(owner, childId, string(args.requestId), args.answer);

      return store.closeChild(owner, childId);
    }

    case "message": {
      return store.mail.message(childId, string(args.commandId), { message: args.message });
    }

    case "claim": {
      return store.queue.claim(owner, childId);
    }

    case "holdDelivery": {
      delivery.gate = Promise.withResolvers<undefined>();

      return;
    }

    case "deliveryStatus": {
      delivery.status = string(args.status);

      return;
    }

    case "releaseDelivery": {
      delivery.gate?.resolve(undefined);
      delivery.gate = undefined;

      return;
    }

    case "barrier": {
      await worker?.tick();

      return;
    }

    case "stop": {
      for (const adapter of adapters.values()) {
        adapter.release();
      }

      delivery.gate?.resolve(undefined);
      await worker?.stop();
      store.close();
      process.disconnect();

      return;
    }

    default: {
      adapterCommand(method, childId);

      return;
    }
  }
}

/**
Serializes one normalized IPC operation result or explicit failure.
@param request - Normalized request with its original correlation identity.
@returns Completion of command execution and its IPC reply.
*/
async function respond(request: ReturnType<typeof hostRequest>) {
  try {
    send({ id: request.id, result: await execute(request) });
  } catch (error) {
    send({ id: request.id, error: String(error) });
  }
}

process.on("message", (input: unknown) => {
  const request = hostRequest(input);

  if (request.method === "createAndCrash") {
    try {
      const child = store.create(owner, request.args);

      send({ id: request.id, result: child });
      // The crash fault must skip the notification microtask after the durable commit.
      process.exit(CRASH_EXIT_CODE);
    } catch (error) {
      send({ id: request.id, error: String(error) });
    }

    return;
  }

  void respond(request);
});

worker?.start();
send({ event: "ready" });
