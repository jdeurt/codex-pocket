const MAX_READS = 4;
const queue: { priority: number; run: () => Promise<void> }[] = [];
const state = { active: 0 };

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
export function agentRead<T>(read: () => Promise<T>, priority = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: async () => {
        try {
          resolve(await read());
        } catch (error) {
          reject(error);
        } finally {
          state.active--;
          drain();
        }
      },
    });
    drain();
  });
}
