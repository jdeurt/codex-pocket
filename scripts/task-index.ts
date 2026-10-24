import { taskIndexRequest } from "../src/server/task-index-protocol";
import { runTaskIndex } from "../src/server/task-index";

/** Return one IPC reply, then release the child process channel.
@param reply - Serialized result or error.
*/
function send(reply: unknown) {
  process.send?.(reply, () => {
    process.disconnect();
  });
}

/** Report a worker failure without leaking unstructured output into the MCP transport.
@param error - Operation failure.
*/
function sendError(error: unknown) {
  send({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

/** Validate IPC before opening a parent index, then close the channel after the result is sent.
@param message - One operation from the owning host/MCP process.
*/
async function execute(message: unknown) {
  const request = taskIndexRequest.safeParse(message);

  if (!request.success) {
    sendError(request.error);

    return;
  }

  const { owner, query, offset, isKeywordOnly } = request.data;

  await runTaskIndex(owner, query, offset, isKeywordOnly)
    .then((page) => {
      send({ ok: true, page });
    })
    .catch(sendError);
}

// This process handles one parent's operation and never receives provider credentials as tool input.
process.once("message", (message: unknown) => {
  void execute(message);
});
