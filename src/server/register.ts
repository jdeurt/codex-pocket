import { t as captureResult } from "try";
import { startNamedPockets, stopNamedPockets } from "./named-pockets";
import { log } from "./logging";

/**
Register process diagnostics and acquire runtime resources outside production compilation.
*/
export async function registerNode() {
  log().info({ node: process.version, cwd: process.cwd() }, "server.started");
  process.on("uncaughtExceptionMonitor", (error) => {
    log().fatal({ error }, "server.uncaught_exception");
  });
  process.on("warning", (warning) => {
    log().warn({ warning }, "server.warning");
  });

  if (process.env.NEXT_PHASE === "phase-production-build" || !process.env.CODEX_THREAD_ID) {
    return;
  }

  process.once("SIGTERM", () => void stopNamedPockets());
  process.once("SIGINT", () => void stopNamedPockets());
  const started = await captureResult(startNamedPockets);

  if (!started.ok) {
    log().error({ error: started.error }, "server.startup_failed");
  }
}
