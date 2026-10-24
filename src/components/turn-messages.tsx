"use client";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { ChatMessage } from "./chat-message";
import type { Item } from "@/lib/protocol";
import type { TurnEntry } from "@/lib/turn-messages";
import { useState } from "react";
import { collapseDetail } from "../runtime/disclosure-click";

/** Render a canonical message with its stable native identity.
@param item - Normalized transcript item.
@returns One keyed message row.
*/
function messageRow(item: Item) {
  return <ChatMessage item={item} key={item.id} />;
}

/**
Keep completed commentary in the existing animated activity disclosure.
@param props - Ordered normalized commentary items owned by this completed group.
@returns The native activity disclosure with its canonical message rows.
*/
function CompletedActivity({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger className="min-h-11" variant="activity">
          <TraceLine size="md" variant="activity">
            <TraceTitle>{open ? "Hide activity" : "Show activity"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent
          variant="messages"
          onClick={collapseDetail.bind(undefined, setOpen.bind(undefined, false))}
        >
          <div className="activity-messages">{Array.from(items, messageRow)}</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** Render one canonical message or completed activity group.
@param entry - Already projected transcript entry.
@returns Matching keyed message or activity disclosure.
*/
function turnEntry(entry: TurnEntry) {
  return entry.kind === "activity" ? (
    <CompletedActivity key={entry.id} items={entry.items} />
  ) : (
    <ChatMessage key={entry.item.id} item={entry.item} />
  );
}

/**
Render canonical message and activity entries without applying a second source filter.
@param props - Ordered entries from the shared turn-message projection.
@returns The matching rows, or null when no entry is renderable.
*/
export function TurnMessages({ entries }: { entries: TurnEntry[] }) {
  return entries.length === 0 ? null : <div className="turn-messages">{Array.from(entries, turnEntry)}</div>;
}
