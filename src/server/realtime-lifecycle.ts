/* eslint-disable @typescript-eslint/no-magic-numbers -- Native close has a bounded five-second deadline. */
import { type Bridge } from "./bridge-session";
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
Queue stop on the existing RPC after an uncertain audio wait is drained.
The bridge remains serialized until native close or the bounded deadline.
@param owner - The selected parent bridge.
@param rpc - Connection captured before entering the bridge queue.
@param threadId - Thread captured for this realtime session.
@param deadline - Native close deadline begun at stop invocation.
@param canStop - Whether this session is still stopping or uncertain.
@param hasDeadlineSettled - Whether the caller has already stopped waiting.
@param onStopError - Preserve an actual native stop error for status reporting.
*/
export function drainRealtimeStop(
  owner: Bridge,
  rpc: CodexRpc | undefined,
  threadId: string | undefined,
  deadline: Promise<void>,
  canStop: () => boolean,
  hasDeadlineSettled: () => boolean,
  onStopError: (error: unknown) => void
) {
  void owner
    .exclusive(async () => {
      if (
        !rpc ||
        !threadId ||
        !rpc.running ||
        owner.snapshot.connection !== "connected" ||
        owner.agentReader() !== rpc ||
        !canStop()
      ) {
        return;
      }

      // Acknowledgment never proves shutdown; native closed remains the barrier.
      void rpc.request("thread/realtime/stop", { threadId }).catch((error: unknown) => {
        onStopError(error);
      });

      if (hasDeadlineSettled()) {
        rpc.abandonRealtime("thread/realtime/stop");
      }

      await deadline;
    })
    .catch(() => {
      // The caller observes the same deadline and records the uncertain state.
    });
}
