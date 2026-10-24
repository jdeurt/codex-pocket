import { configForPocket, pocketHost, requestConfig } from "./pocket-config";
import { CodexRpc } from "./rpc";
import { type Config } from "./config";
import { NamedRuntime } from "./named-runtime";
import { log } from "./logging";
import { pocketStore } from "./pocket-store";

declare global {
  var namedPocketRuntimes: Map<string, NamedRuntime> | undefined;
}
const runtimes = globalThis.namedPocketRuntimes ?? new Map<string, NamedRuntime>();

if (!globalThis.namedPocketRuntimes) {
  Object.defineProperty(globalThis, "namedPocketRuntimes", { value: runtimes, configurable: true });
}

/** Reuse background resources for the saved parent, independent of menu selection.
@param id - Durable Pocket identity.
@param config - Verified host-owned configuration.
@returns This parent's process resource owner.
*/
function runtimeFor(id: string, config: Config) {
  const existing = runtimes.get(id);
  const runtime = existing ?? new NamedRuntime(id, config);

  runtimes.set(id, runtime);

  return runtime;
}

/** Resolve the exact saved conversation for an authorized browser request.
@param request - Request carrying an explicit per-tab selection.
@param isStreaming - Whether the SSE owner must subscribe before hydration completes.
@returns Its independent bridge.
*/
export async function requestBridge(request: Request, isStreaming = false) {
  const config = await requestConfig(request);
  const runtime = runtimeFor(config.pocketId ?? "main", config);

  if (isStreaming) {
    void runtime.connect().catch((error: unknown) => {
      log().error({ error }, "pocket.reconnect_failed");
    });
  } else {
    await runtime.connect();
  }

  return runtime.bridge;
}

/**
Start all saved parents independently; retain failures for the next explicit reconnect.
*/
export async function startNamedPockets() {
  await pocketHost();
  pocketStore().recover();
  await Promise.allSettled(
    pocketStore()
      .list()
      .filter((entry) => entry.state === "ready")
      .map(async (entry) => {
        const runtime = runtimeFor(entry.id, await configForPocket(entry.id));

        await runtime.connect();
      })
  );
}

/** Start and name the native thread on a connected creation transport.
@param rpc - Native transport already connected without parent tools.
@param config - Host-owned launch policy.
@param id - Reserved creation receipt.
@param name - Validated name.
*/
async function materialize(rpc: CodexRpc, config: Config, id: string, name: string) {
  const { thread } = await rpc.request("thread/start", {
    cwd: config.cwd,
    ephemeral: false,
    persistExtendedHistory: true,
  });

  pocketStore().attach(id, thread.id);
  // Naming persists an empty thread, verified using a second real app-server process.
  await rpc.request("thread/name/set", { threadId: thread.id, name });
  pocketStore().finish(id, true);
}

/** Own a creation transport and persist uncertainty instead of replaying native work.
@param config - Host-owned launch policy.
@param id - Reserved creation receipt.
@param name - Validated name.
*/
async function createNative(config: Config, id: string, name: string) {
  const rpc = new CodexRpc();

  await (async () => {
    await rpc.connect(config, "bare");
    await materialize(rpc, config, id, name);
  })()
    .catch((error: unknown) => {
      pocketStore().finish(id, false);
      throw error;
    })
    .finally(() => {
      rpc.close();
    });
}

/** Persist a named empty conversation before making it selectable.
@param id - Durable caller-generated creation receipt.
@param name - Validated display name.
@returns Saved entry, including the prior outcome for an idempotent retry.
*/
export async function createPocket(id: string, name: string) {
  const config = await pocketHost();
  const store = pocketStore();

  if (store.reserve(id, name)) {
    await createNative(config, id, name);
    void runtimeFor(id, await configForPocket(id))
      .connect()
      .catch((error: unknown) => {
        log().error({ error, id }, "pocket.start_failed");
      });
  }

  return store.get(id);
}

/** Remove only a saved idle parent; retain native history and private delivery receipts.
@param id - Pocket explicitly selected for deletion.
*/
export async function deletePocket(id: string) {
  const entry = pocketStore().get(id);
  const runtime = entry.state === "ready" ? runtimeFor(id, await configForPocket(id)) : undefined;

  if (entry.state === "creating") {
    throw new Error("This Pocket is still being created. Wait for setup to finish before deleting it.");
  }

  if (runtime) {
    await runtime.remove();
  } else {
    pocketStore().remove(id);
  }

  runtimes.delete(id);
}

/**
Stop every background owner when the host shuts down, without changing its saved catalog.
*/
export async function stopNamedPockets() {
  await Promise.allSettled(runtimes.values().map((runtime) => runtime.close()));
  runtimes.clear();
}
