import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "./rpc-events";
import { type CodexRpc } from "./rpc";
import { type RpcEvent } from "../lib/protocol";
import { log } from "./logging";

/** Forward validated native notifications to their explicit connection owner.
@param notify - Owning connection callback.
@param event - Native transport event.
*/
function notification(notify: (event: RpcEvent) => void, event: Event) {
  if (event instanceof RpcNotificationEvent) {
    notify(event.notification);
  }
}

/** Forward native connection loss to its explicit owner.
@param disconnect - Owning connection callback.
@param event - Native transport event.
*/
function disconnected(disconnect: (error: Error) => void, event: Event) {
  if (event instanceof RpcDisconnectEvent) {
    disconnect(event.error);
  }
}

/** Keep native account diagnostics in the host log.
@param event - Native diagnostic event.
*/
function diagnostic(event: Event) {
  if (event instanceof RpcDiagnosticEvent) {
    log().debug({ text: event.text }, "codex.stderr");
  }
}

/** Bind typed callbacks to one owned native transport lifetime.
@param rpc - Owned transport.
@param notify - Notification callback, including current-connection validation.
@param disconnect - Disconnection callback, including current-connection validation.
*/
export function observeBridge(rpc: CodexRpc, notify: (event: RpcEvent) => void, disconnect: (error: Error) => void) {
  rpc.addEventListener("event", notification.bind(undefined, notify));
  rpc.addEventListener("disconnect", disconnected.bind(undefined, disconnect));
  rpc.addEventListener("diagnostic", diagnostic);
}
