import { type ClientRecord, parsedDiagnostics, remainingDiagnostics } from "../state/diagnostics";
import { t } from "try";

export { clientError } from "../state/diagnostics";

const STORAGE_KEY = "pocket-diagnostics";
const MAX_RECORDS = 100;
const BATCH_SIZE = 10;
const FLUSH_DELAY_MS = 300;

/** Read saved diagnostics at the browser boundary.
@returns Validated records, or a parse/storage failure for the caller to report.
*/
function storedClientRecords() {
  return parsedDiagnostics(localStorage.getItem(STORAGE_KEY) ?? "[]");
}

/** Save the explicit runtime queue without capturing its owner.
@param records - Current queued diagnostics.
*/
function storeClientRecords(records: ClientRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/**
Own one browser page's diagnostics queue, storage and delivery timer.
*/
class ClientDiagnostics {
  private records: ClientRecord[] = [];
  private isLoaded = false;
  private isSending = false;
  private timer?: ReturnType<typeof setTimeout>;

  /**
  Schedule asynchronous delivery from a native timer callback.
  */
  private flushScheduled = () => {
    void this.flush();
  };

  /**
  Send a batch while retaining failed records for the next online event or diagnostic.
  */
  flush = async () => {
    if (this.isSending || this.records.length === 0 || !navigator.onLine) {
      return;
    }

    this.isSending = true;
    const sent = await t(this.transmit.bind(this), this.records.slice(0, BATCH_SIZE));

    this.isSending = false;

    if (!sent.ok) {
      console.warn("Could not send Pocket diagnostics; records remain queued.", sent.error);

      return;
    }

    if (this.records.length > 0) {
      this.timer = setTimeout(this.flushScheduled, FLUSH_DELAY_MS);
    }
  };

  /** Record explicit event data with browser-generated identity and time.
  @param event - Stable diagnostic name.
  @param details - Serializable context.
  @param level - Severity.
  */
  report = (event: string, details: Record<string, unknown> = {}, level: ClientRecord["level"] = "info") => {
    if (typeof window === "undefined") {
      return;
    }

    if (!this.isLoaded) {
      const restored = t(storedClientRecords);

      this.isLoaded = true;

      if (restored.ok) {
        this.records = restored.value;
      } else {
        console.warn("Could not restore Pocket diagnostics; starting an empty queue.", restored.error);
      }
    }

    this.records = [
      ...this.records,
      {
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        level,
        event,
        details,
      },
    ].slice(-MAX_RECORDS);
    this.persist();
    clearTimeout(this.timer);
    this.timer = setTimeout(this.flushScheduled, FLUSH_DELAY_MS);
  };

  /**
  Persist best-effort diagnostics and report failures without recursively queueing them.
  */
  private persist() {
    const saved = t(storeClientRecords, this.records);

    if (!saved.ok) {
      console.warn("Could not persist Pocket diagnostics.", saved.error);
    }
  }

  /** Send one explicit batch and retire only acknowledged identities.
  @param batch - Queue snapshot reserved for this request.
  */
  private async transmit(batch: ClientRecord[]) {
    const response = await fetch("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    });

    if (!response.ok) {
      throw new Error(`Diagnostics request failed with status ${String(response.status)}.`);
    }

    this.records = remainingDiagnostics(this.records, batch);
    this.persist();
  }
}

const diagnostics = new ClientDiagnostics();

export const reportClient = diagnostics.report;
export const flushClientLogs = diagnostics.flush;
