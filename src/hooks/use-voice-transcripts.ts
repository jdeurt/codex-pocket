"use client";
import { type VoiceSegment, voiceHistorySchema, voiceSegmentSchema } from "@/lib/voice-history";
import { useCallback, useEffect, useRef, useState } from "react";
import { dataSchema } from "@/lib/protocol";
import { pocketUrl } from "@/lib/pockets";

/**
Restore finalized speech after reload and upsert provider events by their stable provenance.
@param threadId - Connected conversation identity; absent during setup or disconnection.
@returns Saved speech, display errors and handlers shared by stream and stop finalization.
*/
export function useVoiceTranscripts(threadId?: string) {
  const [segments, setSegments] = useState<VoiceSegment[]>([]);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const generation = useRef(0);
  const url = useRef(pocketUrl("/api/realtime"));
  const isMounted = useCallback(() => mounted.current, []);
  const refresh = useCallback(async () => {
    if (!isMounted()) {
      return;
    }

    const attempt = generation.current;
    const response = await fetch(url.current, { cache: "no-store" });

    if (!response.ok) {
      throw new Error("Voice history could not load. Reconnect Pocket and try again.");
    }

    if (!isMounted() || generation.current !== attempt) {
      return;
    }

    const result = dataSchema.parse(await response.json());

    if (!isMounted() || generation.current !== attempt) {
      return;
    }

    const saved = voiceHistorySchema.parse(result.history);

    setSegments((current) => new Map([...current, ...saved].map((entry) => [entry.id, entry])).values().toArray());
    setError("");
  }, [isMounted]);
  const transcript = useCallback((entry: VoiceSegment) => {
    setSegments((current) => new Map([...current, entry].map((segment) => [segment.id, segment])).values().toArray());
  }, []);
  const handoff = useCallback((id: string, value: unknown, handoffId?: string) => {
    const status = voiceSegmentSchema.shape.handoff.safeParse(value);

    if (status.success) {
      setSegments((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, handoff: status.data, handoffId } : entry))
      );
    }
  }, []);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    mounted.current = true;
    const reload = () =>
      void refresh().catch(() => {
        if (mounted.current) {
          setError("Voice history could not load. Reconnect Pocket and try again.");
        }
      });

    reload();
    globalThis.addEventListener("pocket-voice-history", reload);

    return () => {
      globalThis.removeEventListener("pocket-voice-history", reload);
      mounted.current = false;
      generation.current++;
    };
  }, [refresh, threadId]);

  return {
    segments,
    error,
    refresh,
    transcript,
    handoff,
    dismissError: () => {
      setError("");
    },
  };
}
