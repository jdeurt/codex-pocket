import { type AdapterOptions, type HarnessAdapter, type HarnessResult } from "../../src/server/harness/types";
import { object, string } from "../../src/lib/protocol";
import { DelegationStore } from "../../src/server/delegations";
import { DelegationWorker } from "../../src/server/delegation-worker";
import { configSchema } from "../../src/server/config";

// Simulator for process-level delegation integration flows. Never loads a model.

if (process.env.CODEX_THREAD_ID || !process.env.CODEX_POCKET_STATE_DIR) {
  throw new Error("Integration host requires private state and no inherited model thread.");
}

const owner = "integration-parent";
const store = new DelegationStore(process.env.CODEX_POCKET_STATE_DIR);
const adapters = new Map<string, SimulatedAdapter>();
const send = (data: unknown) => {
  if (process.connected) {
    process.send?.(data);
  }
};
const SIMULATOR_RECOVERY_MS = 60_000;
const CRASH_EXIT_CODE = 77;
const delivery: { status: string; gate?: ReturnType<typeof Promise.withResolvers<undefined>> } = { status: "sent" };

class SimulatedAdapter implements HarnessAdapter {
  private resolve?: (result: HarnessResult) => void;

  private reject?: (error: Error) => void;

  private closing?: Promise<void>;

  private releaseClose?: () => void;

  private closeGate?: Promise<void>;

  constructor(
    private options: AdapterOptions,
    private harness: string
  ) {
    adapters.set(options.child.id, this);
  }

  open() {
    return Promise.resolve(this.options.child.sessionId ?? `saved:${this.options.child.id}`);
  }

  run(id: string, text: string) {
    if (text === "hold-close") {
      this.closeGate = new Promise((resolve) => {
        this.releaseClose = resolve;
      });
    }

    return new Promise<HarnessResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      send({ event: "started", id, childId: this.options.child.id, harness: this.harness, text });
    });
  }

  complete() {
    this.resolve?.({ status: "completed", text: "Simulated result" });
  }

  fail() {
    this.reject?.(new Error("Simulated disconnect after send"));
  }

  async ask() {
    try {
      const answer = await this.options.callbacks.request({
        id: "native-question",
        kind: "question",
        method: "AskUserQuestion",
        input: { question: "Color?" },
      });

      send({ event: "answer", childId: this.options.child.id, answer });
    } catch (error) {
      send({ event: "cancelled", childId: this.options.child.id, error: String(error) });
    }
  }

  release() {
    this.releaseClose?.();
  }

  history() {
    return Promise.resolve([]);
  }

  interrupt() {
    this.resolve?.({ status: "interrupted", text: "Closed" });

    return Promise.resolve();
  }

  async archive() {
    await this.interrupt();
  }

  close() {
    this.closing ??= (async () => {
      await this.interrupt();
      await this.closeGate;
      send({ event: "exited", childId: this.options.child.id });
    })();

    return this.closing;
  }
}

const worker =
  process.env.DELEGATION_HOST_MODE === "worker"
    ? new DelegationWorker(
        store,
        {
          send: async (id, text) => {
            send({ event: "mail", id, text });
            await delivery.gate?.promise;

            return { status: delivery.status };
          },
        },
        configSchema.parse({ threadId: owner, cwd: process.cwd() }),
        {
          createAdapter: (harness, options) => new SimulatedAdapter(options, harness),
          recoveryIntervalMs: Number(process.env.DELEGATION_RECOVERY_MS ?? SIMULATOR_RECOVERY_MS),
        }
      )
    : undefined;

process.on("message", (message) => {
  const { id, method } = object(message);
  const args = object(object(message).args);
  const childId = string(args.childId);

  void (async () => {
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

      case "createAndCrash": {
        const child = store.create(owner, args);

        send({ id, result: child });
        process.exit(CRASH_EXIT_CODE); // Skip the notification microtask after committing.
        break;
      }

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
        throw new Error(`Unexpected simulator command ${String(method)}`);
      }
    }
  })()
    .then((result) => {
      send({ id, result });
    })
    .catch((error: unknown) => {
      send({ id, error: String(error) });
    });
});

worker?.start();
send({ event: "ready" });
