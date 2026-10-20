"use client";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { ReactNode } from "react";

/**
Keep the activity indicator in a standard scroller item with shared message spacing.
@param props - Activity indicator and optional agent-browser control.
@returns The existing activity row.
*/
export function ActivityRow({ children }: { children: ReactNode }) {
  return (
    <MessageScrollerItem messageId="thinking" className="activity-item">
      <div className="activity-row">{children}</div>
    </MessageScrollerItem>
  );
}
