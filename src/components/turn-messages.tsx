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
import { collapseDetail } from "@/lib/disclosure-click";

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
          onClick={(event) => {
            collapseDetail(event, () => {
              setOpen(false);
            });
          }}
        >
          <div className="activity-messages">
            {items.map((item) => (
              <ChatMessage item={item} key={item.id} />
            ))}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/**
Render canonical message and activity entries without applying a second source filter.
@param props - Ordered entries from the shared turn-message projection.
@returns The matching rows, or null when no entry is renderable.
*/
export function TurnMessages({ entries }: { entries: TurnEntry[] }) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="turn-messages">
      {entries.map((entry) =>
        entry.kind === "activity" ? (
          <CompletedActivity key={entry.id} items={entry.items} />
        ) : (
          <ChatMessage key={entry.item.id} item={entry.item} />
        )
      )}
    </div>
  );
}
