import { type Data, type RpcEvent, object } from "../src/lib/protocol";
import { type CodexRpc } from "../src/server/rpc";

const TURN_TIMEOUT_MS = 120_000;

export async function seedThread(rpc: CodexRpc, threadId: string, text: string, settings: Data = {}) {
  const completion = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    completion.reject(new Error("The seed turn timed out. Inspect the saved thread."));
  }, TURN_TIMEOUT_MS);
  const listener = (event: RpcEvent) => {
    if (event.method !== "turn/completed" || event.params.threadId !== threadId) {
      return;
    }

    const turn = object(event.params.turn);

    if (turn.status === "completed") {
      completion.resolve(true);
    } else {
      completion.reject(new Error(`The seed turn failed: ${JSON.stringify(turn.error)}`));
    }
  };

  rpc.on("event", listener);

  try {
    await rpc.request("turn/start", {
      ...settings,
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    await completion.promise;
  } finally {
    clearTimeout(timer);
    rpc.off("event", listener);
  }
}
