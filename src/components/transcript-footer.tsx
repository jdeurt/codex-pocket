"use client";
import { type ReactNode } from "react";
import { type VirtualItem } from "@tanstack/react-virtual";

const LAST_ITEM = -1;

/**
Keep interactive pending controls mounted at the standard transcript tail.
@param props - Message count, native visible rows, footer measurement and existing controls.
@returns The existing measured footer container.
*/
export function TranscriptFooter({
  count,
  messages,
  footerRow,
  blockStart,
  measure,
  children,
}: {
  count: number;
  messages: VirtualItem[];
  footerRow?: VirtualItem;
  blockStart: number;
  measure: (element: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const hasTail = count === 0 || messages.at(LAST_ITEM)?.index === count - 1;

  return (
    <div
      ref={measure}
      data-index={count}
      data-slot="transcript-footer"
      className={`message-flow w-full min-w-0 ${count > 0 ? "[&:not(:empty)]:pt-(--message-block-gap)" : ""}`}
      style={{
        position: hasTail ? "static" : "absolute",
        transform: hasTail ? undefined : `translateY(${String((footerRow?.start ?? 0) - blockStart)}px)`,
      }}
    >
      {children}
    </div>
  );
}
