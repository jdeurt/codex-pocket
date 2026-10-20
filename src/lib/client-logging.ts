import { dataSchema } from "./protocol";
import { z } from "zod";

const clientRecordSchema = z.object({
  id: z.string(),
  time: z.string(),
  level: z.enum(["info", "error"]),
  event: z.string(),
  details: dataSchema,
});

interface ClientRecord {
  id: string;
  time: string;
  level: "info" | "error";
  event: string;
  details: Record<string, unknown>;
}
const STORAGE_KEY = "pocket-diagnostics";
const MAX_RECORDS = 100;
const BATCH_SIZE = 10;
const FLUSH_DELAY_MS = 300;
const queue: { records: ClientRecord[]; loaded: boolean; sending: boolean; timer?: ReturnType<typeof setTimeout> } = {
  records: [],
  loaded: false,
  sending: false,
};

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.records));
  } catch {
    /*
    Diagnostics must not block chat.
    */
  }
}

export function clientError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

export async function flushClientLogs() {
  if (queue.sending || queue.records.length === 0 || !navigator.onLine) {
    return;
  }

  queue.sending = true;
  let delivered = false;

  const batch = queue.records.slice(0, BATCH_SIZE);

  try {
    const response = await fetch("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    });

    if (!response.ok) {
      return;
    }

    const ids = new Set(batch.map((entry) => entry.id));

    queue.records = queue.records.filter((entry) => !ids.has(entry.id));
    persist();
    delivered = true;
  } catch {
    /*
    Retain diagnostics while Pocket is restarting or unreachable.
    */
  } finally {
    queue.sending = false;

    if (delivered && queue.records.length > 0) {
      queue.timer = setTimeout(() => void flushClientLogs(), FLUSH_DELAY_MS);
    }
  }
}

export function reportClient(
  event: string,
  details: Record<string, unknown> = {},
  level: ClientRecord["level"] = "info"
) {
  if (typeof window === "undefined") {
    return;
  }

  if (!queue.loaded) {
    queue.loaded = true;

    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");

      if (Array.isArray(saved)) {
        queue.records = saved.flatMap((entry: unknown) => {
          const parsed = clientRecordSchema.safeParse(entry);

          return parsed.success ? [parsed.data] : [];
        });
      }
    } catch {
      /*
      An invalid diagnostics cache can be discarded.
      */
    }
  }

  queue.records = [
    ...queue.records,
    { id: crypto.randomUUID(), time: new Date().toISOString(), level, event, details },
  ].slice(-MAX_RECORDS);
  persist();
  clearTimeout(queue.timer);
  queue.timer = setTimeout(() => void flushClientLogs(), FLUSH_DELAY_MS);
}
