const MAX_READS = 4;
const queue: { priority: number; run: () => Promise<void> }[] = [];
const state = { active: 0 };

/**
Start queued transcript reads by priority while respecting the shared concurrency limit.
*/
function drain() {
  queue.sort((a, b) => a.priority - b.priority);

  while (state.active < MAX_READS && queue.length > 0) {
    const next = queue.shift();

    if (!next) {
      return;
    }

    state.active++;
    void next.run();
  }
}

// Selected chats have priority over background list previews. Every harness
// transcript read shares this limit, including simultaneous image requests.
/**
Queue a native transcript read behind higher-priority selected-chat reads.
@param read - Native read operation whose completion releases its pool slot.
@param priority - Lower values run before background list previews.
@returns The read result, or the original normalized read failure.
*/
export function agentRead<T>(read: () => Promise<T>, priority = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: async () => {
        try {
          resolve(await read());
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Agent history read failed.", { cause: error }));
        } finally {
          state.active--;
          drain();
        }
      },
    });
    drain();
  });
}
