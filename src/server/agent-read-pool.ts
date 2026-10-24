import { t } from "try";

const MAX_READS = 4;
const MAX_BACKGROUND_READS = MAX_READS - 1;
const queue: { key?: string; priority: number; run: () => Promise<void> }[] = [];
const state = { active: 0, background: 0 };

/**
Start queued reads by priority, reserving capacity for the selected transcript.
*/
function drain() {
  queue.sort((a, b) => a.priority - b.priority);

  while (state.active < MAX_READS && queue.length > 0) {
    const next = queue[0];
    const isBackground = next.priority > 0;

    if (isBackground && state.background >= MAX_BACKGROUND_READS) {
      return;
    }

    queue.shift();
    state.active++;

    if (isBackground) {
      state.background++;
    }

    void next.run().finally(() => {
      state.active--;

      if (isBackground) {
        state.background--;
      }

      drain();
    });
  }
}

/**
Promote a queued preview hydration when its conversation is selected.
@param key - Exact scoped native source already used to coalesce the read.
*/
export function promoteAgentRead(key: string) {
  for (const entry of queue) {
    if (entry.key === key) {
      entry.priority = 0;
    }
  }

  drain();
}

/**
Queue native history while retaining a foreground slot and the overall concurrency limit.
@param read - Native operation whose completion releases its pool slot.
@param priority - Zero selects a foreground read; higher values are background work.
@param key - Optional scoped identity allowing a queued read to become foreground work.
@returns Native read result or normalized failure.
*/
export function agentRead<T>(read: () => Promise<T>, priority = 0, key?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      key,
      priority,
      run: async () => {
        const result = await t(read);

        if (result.ok) {
          resolve(result.value);
        } else {
          const error = result.error;

          reject(error instanceof Error ? error : new Error("Agent history read failed.", { cause: error }));
        }
      },
    });
    drain();
  });
}
