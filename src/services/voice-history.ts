import { dataSchema } from "../lib/protocol";
import { voiceHistorySchema } from "../lib/voice-history";
import { mergeCaptions, type VoiceStore } from "../state/voice";

const HISTORY_TIMEOUT_MS = 10_000;

/** Restore persisted captions without coupling their availability to live audio.
@param store - Current Pocket's caption state.
@param url - Explicitly scoped history API.
@returns Refresh and lifecycle methods, with stale responses ignored after disposal.
*/
export function createCaptionHistory(store: VoiceStore, url: string) {
  let generation = 0;
  let isActive = false;
  let pending: AbortController | undefined;

  const isCurrent = (attempt: number) => isActive && generation === attempt;
  const refresh = async () => {
    if (!isActive) {
      return;
    }

    const attempt = ++generation;
    const controller = new AbortController();

    pending?.abort();
    pending = controller;
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS)]),
    });

    if (!response.ok) {
      throw new Error("Voice history could not load. Reconnect Pocket and try again.");
    }

    const result = dataSchema.parse(await response.json());

    if (!isCurrent(attempt)) {
      return;
    }

    mergeCaptions(store, voiceHistorySchema.parse(result.history));
    store.setState({ historyError: "" });
  };
  const reload = () => {
    const task = refresh();
    const attempt = generation;

    void task.catch(() => {
      if (isCurrent(attempt) && !pending?.signal.aborted) {
        store.setState({ historyError: "Voice history could not load. Reconnect Pocket and try again." });
      }
    });
  };

  return {
    refresh,
    connect: () => {
      isActive = true;
      reload();
      globalThis.addEventListener("pocket-voice-history", reload);

      return () => {
        isActive = false;
        generation++;
        pending?.abort();
        globalThis.removeEventListener("pocket-voice-history", reload);
      };
    },
  };
}
