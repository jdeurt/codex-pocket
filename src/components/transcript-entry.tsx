import { type RefObject } from "react";
import { type VirtualItem } from "@tanstack/react-virtual";
import { type TranscriptRow as Row } from "../lib/transcript-virtualization";
import { type TranscriptLayout } from "../state/transcript-layout";
import { type ActivityMeasurements, VirtualizedActivity } from "./virtualized-activity";
import { ChatMessage } from "./chat-message";

const ACTIVITY_LOOKAHEAD_VIEWPORTS = 3;

/**
Render and measure one canonical transcript row with its native virtual position.
@param props - Canonical row, TanStack measurement and the existing viewport/activity callbacks.
@returns The matching measured message or activity row.
*/
export function TranscriptEntry({
  row,
  virtualRow,
  open,
  toggle,
  viewport,
  layout,
  measurements,
  suspended,
}: {
  row: Row;
  virtualRow: VirtualItem;
  open: boolean;
  toggle: () => void;
  viewport: RefObject<HTMLDivElement | null>;
  layout: TranscriptLayout;
  measurements: ActivityMeasurements;
  suspended: boolean;
}) {
  if (row.entry.kind === "message") {
    return <ChatMessage item={row.entry.item} />;
  }

  return (
    <VirtualizedActivity
      id={row.id}
      turnId={row.turnId}
      items={row.entry.items}
      open={open}
      onOpenChange={toggle}
      viewport={viewport}
      origin={virtualRow.start}
      end={virtualRow.end}
      scrollOffset={layout.offset}
      nearby={
        virtualRow.end >= layout.offset - layout.height * 2 &&
        virtualRow.start <= layout.offset + layout.height * ACTIVITY_LOOKAHEAD_VIEWPORTS
      }
      measurements={measurements}
      suspended={suspended}
    />
  );
}
