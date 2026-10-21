/* eslint-disable @typescript-eslint/no-magic-numbers -- Native close has a bounded five-second deadline. */
import { type CodexRpc } from "./rpc";

/**
Wait for the authoritative native close, never just the stop RPC acknowledgment.
@param closed - Promise resolved by the native closed notification.
*/
export async function waitForRealtimeClosed(closed: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Native realtime closure was not confirmed."));
        }, 5000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
Send stop on the captured RPC without waiting for unrelated bridge controls.
@param rpc - Connection captured before entering the bridge queue.
@param threadId - Thread captured for this realtime session.
@param canStop - Whether this session is still stopping or uncertain.
@param onStopError - Preserve an actual native stop error for status reporting.
*/
export function requestRealtimeStop(
  rpc: CodexRpc | undefined,
  threadId: string | undefined,
  canStop: () => boolean,
  onStopError: (error: unknown) => void
) {
  if (!rpc || !threadId || !rpc.running || !canStop()) {
    return;
  }

  // The acknowledgement is not closure; the caller waits for the native closed event.
  void rpc.request("thread/realtime/stop", { threadId }).catch(onStopError);
}
