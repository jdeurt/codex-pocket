import { dataSchema } from "./protocol";
import { z } from "zod";
import { t as attempt } from "try";

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

/**
Save the bounded diagnostics queue without letting storage failures interrupt chat.
*/
function persist() {
  const outcome = attempt(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.records));
  });

  if (!outcome.ok) {
    /*
    Diagnostics must not block chat.
    */
  }
}

/**
Preserve useful exception details in a JSON-compatible diagnostic record.
@param error - Exception or other rejected value received at a client boundary.
@returns Its name/message/stack when available, otherwise a string message.
*/
export function clientError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

/**
Send a bounded diagnostics batch and retire only the IDs acknowledged by the server.
@param batch - Snapshot of records selected before starting this request.
@returns The native response, with queued records retained for unsuccessful statuses.
*/
async function transmitClientBatch(batch: ClientRecord[]) {
  const response = await fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: batch }),
  });

  if (response.ok) {
    const ids = new Set(batch.map((entry) => entry.id));

    queue.records = queue.records.filter((entry) => !ids.has(entry.id));
    persist();
  }

  return response;
}

/**
Send one diagnostics batch when online and no other batch owns the send flag.
*/
export async function flushClientLogs() {
  const batch = queue.records.slice(0, BATCH_SIZE);

  if (queue.sending || batch.length === 0 || !navigator.onLine) {
    return;
  }

  /**
Own the in-flight flag and retry timer for one selected diagnostics batch.
*/
  async function flushClientBatch() {
    let isDelivered = false;

    queue.sending = true;

    await (async () => {
      const response = await transmitClientBatch(batch);

      isDelivered = response.ok;
    })()
      .catch(() => {
        /*
    Retain diagnostics while Pocket is restarting or unreachable.
    */
      })
      .finally(() => {
        queue.sending = false;

        if (isDelivered && queue.records.length > 0) {
          queue.timer = setTimeout(() => void flushClientLogs(), FLUSH_DELAY_MS);
        }
      });
  }

  await flushClientBatch();
}

/**
Read previously saved diagnostics and discard invalid entries at the storage boundary.
@returns Valid records in their original order, or an empty list for another JSON shape.
*/
function storedClientRecords(): ClientRecord[] {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");

  return Array.isArray(saved)
    ? saved.flatMap((entry: unknown) => {
        const parsed = clientRecordSchema.safeParse(entry);

        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

/**
Queue a client diagnostic, persist it locally and schedule a bounded delivery batch.
@param event - Stable event name shared with server diagnostics.
@param [details] - JSON-compatible context whose field values remain unchecked.
@param [level] - Severity, defaulting to info.
*/
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

    const outcome1 = attempt(() => {
      queue.records = storedClientRecords();
    });

    if (!outcome1.ok) {
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
