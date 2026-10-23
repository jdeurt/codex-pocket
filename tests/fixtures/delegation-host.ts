import { type AdapterOptions, type Harness } from "../../src/server/harness/types";
import { type HostPacket, hostRequestSchema } from "./delegation-protocol";
import { CodexAdapter } from "../../src/server/harness/codex";
import { DelegationStore } from "../../src/server/delegations";
import { DelegationWorker } from "../../src/server/delegation-worker";
import { configSchema } from "../../src/server/config";

const directory = process.env.CODEX_POCKET_STATE_DIR;

if (!directory || process.env.CODEX_THREAD_ID || process.env.DELEGATION_HOST_MODE !== "native") {
  throw new Error("The workflow worker requires private native replay state and no inherited parent.");
}

const owner = "integration-parent";
const RECOVERY_MS = 60_000;
const store = new DelegationStore(directory);

/** Publish real worker observations over the test-owned control channel.
@param packet - Actual delivery, native output or startup readiness.
*/
function send(packet: HostPacket) {
  if (process.connected) {
    process.send?.(packet);
  }
}

/** Observe output from the production adapter without replacing its lifecycle or transport.
@param harness - Requested saved harness.
@param options - Real worker callbacks and native launch settings.
@returns Production Codex adapter connected to the external replay process.
*/
function adapter(harness: Harness, options: AdapterOptions) {
  if (harness !== "codex") {
    throw new Error(`Unsupported native worker fixture: ${harness}`);
  }

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

const worker = new DelegationWorker(
  store,
  {
    send: (id, text) => {
      send({ event: "mail", id, text });

      return Promise.resolve({ status: "sent" });
    },
  },
  configSchema.parse({
    threadId: owner,
    cwd: directory,
    codexBinary: process.execPath,
    serverArgs: [
      "--import",
      new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname,
      new URL("delegation-codex.ts", import.meta.url).pathname,
    ],
  }),
  { createAdapter: adapter, recoveryIntervalMs: Number(process.env.DELEGATION_RECOVERY_MS ?? RECOVERY_MS) }
);

/** Join a real worker dispatch pass or stop only after all native subprocesses have exited.
@param input - Explicit read-only dispatch barrier or stop control sent by the fixture owner.
*/
async function control(input: unknown) {
  const message = hostRequestSchema.parse(input);

  if (message.method === "tick") {
    await worker.tick();
    send({ id: message.id, result: {} });

    return;
  }

  if (message.method !== "stop") {
    throw new Error(`Unsupported workflow control: ${message.method}`);
  }

  await worker.stop();
  store.close();
  process.disconnect();
}

process.on("message", (input: unknown) => {
  void control(input);
});
worker.start();
send({ event: "ready" });
