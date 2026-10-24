import { t } from "try";

const MAX_READS = 4;
const MAX_BACKGROUND_READS = MAX_READS - 1;

interface PendingRead {
  key?: string;
  priority: number;
  run: (isBackground: boolean) => Promise<void>;
}

/** Sort native work by requested foreground priority.
@param a - First queued native operation.
@param b - Second queued native operation.
@returns Priority order, preserving equal-priority arrival order.
*/
function comparePriority(a: PendingRead, b: PendingRead) {
  return a.priority - b.priority;
}

/** Promote a matching queued request without changing the original entry.
@param key - Selected native source identity.
@param entry - Queued resource acquisition.
@returns Foreground request when its source was selected.
*/
function promotedRead(key: string, entry: PendingRead) {
  return entry.key === key ? { ...entry, priority: 0 } : entry;
}

/**
Runtime owner of native-read capacity and pending resource acquisitions.
*/
class AgentReadPool {
  private queue: PendingRead[] = [];
  private active = 0;
  private background = 0;

  /** Promote pending native work when its transcript is selected.
  @param key - Exact native source identity.
  */
  promote = (key: string) => {
    this.queue = Array.from(this.queue, promotedRead.bind(undefined, key));
    this.drain();
  };

  /**
  Start native operations while reserving one selected-transcript slot.
  */
  private drain() {
    this.queue = this.queue.toSorted(comparePriority);

    while (this.active < MAX_READS && this.queue.length > 0) {
      const next = this.queue[0];
      const isBackground = next.priority > 0;

      if (isBackground && this.background >= MAX_BACKGROUND_READS) {
        return;
      }

      this.queue = this.queue.slice(1);
      this.active++;
      this.background += Number(isBackground);
      void next.run(isBackground);
    }
  }

  /** Release a native acquisition before starting another queued operation.
  @param isBackground - Whether the released slot used background capacity.
  */
  release(isBackground: boolean) {
    this.active--;
    this.background -= Number(isBackground);
    this.drain();
  }

  /** Queue a native resource acquisition.
  @param entry - Explicit pending read operation.
  */
  enqueue(entry: PendingRead) {
    this.queue = [...this.queue, entry];
    this.drain();
  }
}

const pool = new AgentReadPool();
export const promoteAgentRead = pool.promote;

/** Capture an owned read, release capacity, and preserve the original failure.
@param owner - Resource pool supplying the slot.
@param read - Concrete native read.
@param completion - Caller-owned result.
@param isBackground - Whether this operation acquired a background slot.
*/
async function runRead<T>(
  owner: AgentReadPool,
  read: () => Promise<T>,
  completion: PromiseWithResolvers<T>,
  isBackground: boolean
) {
  const result = await t(read);

  owner.release(isBackground);

  if (result.ok) {
    completion.resolve(result.value);
  } else {
    completion.reject(result.error);
  }
}

/** Queue native history while reserving foreground capacity.
@param read - Native operation owned until completion.
@param priority - Zero selects foreground work.
@param key - Optional native source identity for foreground promotion.
@returns The original native result or failure.
*/
export function agentRead<T>(read: () => Promise<T>, priority = 0, key?: string): Promise<T> {
  const completion = Promise.withResolvers<T>();

  pool.enqueue({ key, priority, run: (runRead<T>).bind(undefined, pool, read, completion) });

  return completion.promise;
}
