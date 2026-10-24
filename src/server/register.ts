import { t as captureResult } from "try";
import { startNamedPockets, stopNamedPockets } from "./named-pockets";
import { log } from "./logging";

/** Preserve diagnostics for an uncaught native exception.
@param error - Original process failure.
*/
function uncaught(error: Error) {
  log().fatal({ error }, "server.uncaught_exception");
}

/** Preserve a native process warning.
@param warning - Original process warning.
*/
function warned(warning: Error) {
  log().warn({ warning }, "server.warning");
}

/**
Join every owned Pocket and report any shutdown failures.
*/
async function shutdown() {
  const stopped = await captureResult(stopNamedPockets);

  if (stopped.ok) {
    return;
  }

  log().error({ error: stopped.error }, "server.shutdown_failed");
  process.exitCode = 1;
}

/**
Enter asynchronous shutdown from a synchronous native signal callback.
*/
function signalled() {
  void shutdown();
}

/**
Register process diagnostics and acquire runtime resources outside production compilation.
*/
export async function registerNode() {
  log().info({ node: process.version, cwd: process.cwd() }, "server.started");
  process.on("uncaughtExceptionMonitor", uncaught);
  process.on("warning", warned);

  if (process.env.NEXT_PHASE === "phase-production-build" || !process.env.CODEX_THREAD_ID) {
    return;
  }

  process.once("SIGTERM", signalled);
  process.once("SIGINT", signalled);
  const started = await captureResult(startNamedPockets);

  if (!started.ok) {
    log().error({ error: started.error }, "server.startup_failed");
  }
}
