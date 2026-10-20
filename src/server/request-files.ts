/** Keep native approval IDs isolated between independent parent app-server processes.
@param threadId - Native parent identity owning the pending prompts.
@returns Private path with backwards compatibility for the configured original Pocket.
*/
export function requestFile(threadId?: string) {
  return threadId && threadId !== process.env.CODEX_THREAD_ID
    ? `requests/${encodeURIComponent(threadId)}.json`
    : "requests.json";
}
