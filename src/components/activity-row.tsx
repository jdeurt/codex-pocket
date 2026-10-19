"use client";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { ReactNode } from "react";

export function ActivityRow({ children }: { children: ReactNode }) {
  return (
    <MessageScrollerItem messageId="thinking" className="activity-item">
      <div className="activity-row">{children}</div>
    </MessageScrollerItem>
  );
}
