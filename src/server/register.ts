import { DelegationWorker } from "./delegation-worker";
import { Scheduler } from "./scheduler";
import { bridge } from "./bridge";
import { delegations } from "./delegations";
import { log } from "./logging";
import { readConfig } from "./config";
import { schedules } from "./schedules";

export function registerNode() {
  log().info({ node: process.version, cwd: process.cwd() }, "server.started");
  process.on("uncaughtExceptionMonitor", (error) => log().fatal({ error }, "server.uncaught_exception"));
  process.on("warning", (warning) => log().warn({ warning }, "server.warning"));

  if (process.env.NEXT_PHASE !== "phase-production-build") {
    void (async () => {
      const config = await readConfig();

      if (!config) {
        return;
      }

      const scheduler = new Scheduler(schedules(), bridge, config.threadId);
      scheduler.start();
      await bridge.ensureConnected();
      const worker = new DelegationWorker(delegations(), bridge, config);
      worker.start();
      process.once("SIGTERM", () => void worker.stop());
      process.once("SIGINT", () => void worker.stop());
    })().catch((error: unknown) => log().error({ error }, "server.startup_failed"));
  }
}
