"use client";
import { ActivityIndicatorContext } from "@/lib/activity-indicator-context";
import { ActivityRow } from "./activity-row";
import { ActivitySpinner } from "./activity-spinner";
import { type ReactNode } from "react";
import { type Snapshot } from "@/lib/protocol";

/** Render current work and agents within the reserved transcript status row.
@param props - Current parent state and optional agents control sharing the reserved row.
@returns The activity row and its accessible status content.
*/
export function ConversationActivity({
  state,
  control,
  isWorking = !!state.activeTurnId,
}: {
  state: Snapshot;
  control?: ReactNode;
  isWorking?: boolean;
}) {
  const isThinking = isWorking && state.requests.length === 0;
  const activity = state.activity ?? "Considering options";
  const indicator = isThinking ? (
    <div
      className="activity-indicator"
      role="status"
      aria-label="Pocket activity"
      aria-live="polite"
      aria-atomic="true"
    >
      <ActivitySpinner />
      {activity && <span className="min-w-0 truncate">{activity}</span>}
    </div>
  ) : null;

  return control ? (
    <ActivityIndicatorContext.Provider value={indicator}>{control}</ActivityIndicatorContext.Provider>
  ) : (
    <ActivityRow>{indicator}</ActivityRow>
  );
}
