import { type CodexRpc } from "../src/server/rpc";
import { type Data } from "../src/lib/protocol";
import { RpcNotificationEvent } from "../src/server/rpc-events";

const TURN_TIMEOUT_MS = 120_000;

/**
Run a deliberately authorized seed turn and await its matching native completion.
@param rpc - Existing connected native client.
@param threadId - Explicit target session identity.
@param text - Seed input selected by the calling integration script.
@param settings - Native turn settings supplied by that script.
@returns Completion after the native turn succeeds, with listeners and timeout released.
*/
export async function seedThread(rpc: CodexRpc, threadId: string, text: string, settings: Data = {}) {
  const completion = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    completion.reject(new Error("The seed turn timed out. Inspect the saved thread."));
  }, TURN_TIMEOUT_MS);
  const listener = (event: Event) => {
    if (
      !(event instanceof RpcNotificationEvent) ||
      event.notification.method !== "turn/completed" ||
      event.notification.params.threadId !== threadId
    ) {
      return;
    }

    if (event.notification.params.turn?.status === "completed") {
      completion.resolve(true);
    } else {
      completion.reject(new Error(`The seed turn failed: ${JSON.stringify(event.notification.params.turn?.error)}`));
    }
  };

  rpc.addEventListener("event", listener);

  await rpc
    .request("turn/start", {
      ...settings,
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    })
    .then(() => completion.promise)
    .finally(() => {
      clearTimeout(timer);
      rpc.removeEventListener("event", listener);
    });
}
