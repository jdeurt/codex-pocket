"use client";
import type { ReactNode } from "react";

/**
Reserve a stable status area at the transcript tail, including when its controls are absent.
@param props - Activity indicator and optional agent-browser control.
@returns The existing activity row.
*/
export function ActivityRow({ children }: { children: ReactNode }) {
  return (
    <div className="activity-item">
      <div className="activity-row">{children}</div>
    </div>
  );
}
