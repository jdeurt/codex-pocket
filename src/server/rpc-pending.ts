import { RpcError } from "./rpc-protocol";
import { log } from "./logging";

export interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
}

/**
Abandon only a realtime request's wait, retaining the shared native transport.
Late responses still carry their original ID and find no pending recipient.
@param pending - Requests on the current native connection.
@param method - The audio or stop method whose result is now uncertain.
*/
export function abandonPendingRealtime(
  pending: Map<number, PendingResponse>,
  method: "thread/realtime/appendAudio" | "thread/realtime/stop"
) {
  for (const [id, request] of pending) {
    if (request.method !== method) {
      continue;
    }

    pending.delete(id);
    clearTimeout(request.timer);
    request.reject(new RpcError(`Codex did not acknowledge ${method}. Its outcome is unknown; realtime is stopping.`));
    log().warn({ method, id }, "codex.rpc.realtime_abandoned");
  }
}
