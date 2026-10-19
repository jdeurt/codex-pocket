import { log } from "./logging";

export function registerNode() {
  log().info({ node: process.version, cwd: process.cwd() }, "server.started");
  process.on("uncaughtExceptionMonitor", (error) => log().fatal({ error }, "server.uncaught_exception"));
  process.on("warning", (warning) => log().warn({ warning }, "server.warning"));
}
