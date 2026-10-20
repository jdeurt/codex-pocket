import { type Config, readConfig } from "./config";
import { DelegationWorker } from "./delegation-worker";
import { Scheduler } from "./scheduler";
import { bridge } from "./bridge";
import { delegations } from "./delegations";
import { log } from "./logging";
import { schedules } from "./schedules";

/**
Start delegated work only after the parent bridge has connected, retaining native shutdown ownership.
@param config - Validated parent configuration that owns the worker and private store.
*/
function startDelegationWorker(config: Config) {
  const worker = new DelegationWorker(delegations(), bridge, config);

  worker.start();
  process.once("SIGTERM", () => void worker.stop());
  process.once("SIGINT", () => void worker.stop());
}

/**
Start the scheduler before connecting the parent, then acquire the child worker after connection.
@param config - Validated parent configuration for these process-owned resources.
*/
async function startConfiguredRuntime(config: Config) {
  const scheduler = new Scheduler(schedules(), bridge, config.threadId);

  scheduler.start();
  await bridge.ensureConnected();
  startDelegationWorker(config);
}

/**
Leave unconfigured test/build processes idle and start only explicitly attached runtime resources.
*/
async function startRuntime() {
  const config = await readConfig();

  if (config) {
    await startConfiguredRuntime(config);
  }
}

/**
Register process diagnostics and acquire runtime resources outside production compilation.
*/
export function registerNode() {
  log().info({ node: process.version, cwd: process.cwd() }, "server.started");
  process.on("uncaughtExceptionMonitor", (error) => {
    log().fatal({ error }, "server.uncaught_exception");
  });
  process.on("warning", (warning) => {
    log().warn({ warning }, "server.warning");
  });

  if (process.env.NEXT_PHASE !== "phase-production-build") {
    void startRuntime().catch((error: unknown) => {
      log().error({ error }, "server.startup_failed");
    });
  }
}
