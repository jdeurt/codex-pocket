import { clientError, flushClientLogs, reportClient } from "./runtime/client-logging";

globalThis.addEventListener("error", (event) => {
  reportClient(
    "client.error",
    { ...clientError(event.error), filename: event.filename, line: event.lineno, column: event.colno },
    "error"
  );
});
globalThis.addEventListener("unhandledrejection", (event) => {
  reportClient("client.unhandled_rejection", clientError(event.reason), "error");
});
globalThis.addEventListener("online", () => {
  reportClient("client.online");
  void flushClientLogs();
});
globalThis.addEventListener("offline", () => {
  reportClient("client.offline");
});
globalThis.addEventListener("pageshow", (event) => {
  reportClient("client.pageshow", { restored: event.persisted });
});
document.addEventListener("visibilitychange", () => {
  reportClient("client.visibility", { state: document.visibilityState });
  void flushClientLogs();
});
reportClient("client.loaded", {
  userAgent: navigator.userAgent,
  url: location.href,
  online: navigator.onLine,
  width: innerWidth,
  height: innerHeight,
  pixelRatio: devicePixelRatio,
});
