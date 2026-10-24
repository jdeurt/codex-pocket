"use client";
import { type Item, string } from "@/lib/protocol";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "./ui/trace";
import { ChatImage } from "./chat-image";
import { XIcon } from "lucide-react";
import { collapseDetail } from "../runtime/disclosure-click";
import { toolTitles } from "@/lib/tool-label";
import { useState } from "react";

/** Render one explicit tool title and failure state.
@param isFailed - Whether this tool invocation failed.
@param title - Normalized display label.
@returns One keyed trace label.
*/
function toolTitle(isFailed: boolean, title: string) {
  return (
    <TraceLine key={title} status={isFailed ? "error" : undefined}>
      {isFailed && <XIcon aria-hidden="true" className="size-3 shrink-0" />}
      {isFailed && <span className="sr-only">Failed: </span>}
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  );
}

/** Render a normalized tool image.
@param image - Original image source.
@returns A keyed guarded preview.
*/
function toolImage(image: NonNullable<Item["images"]>[number]) {
  return <ChatImage key={image.source} source={image.source} />;
}

/**
Present shared native tool text, errors and image output without executing display data.
@param props - Normalized tool-trace item from the shared native adapter.
@returns The existing activity line and optional expandable output.
*/
export function ToolMessage({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const isFailed = item.status === "failed";
  const isRunning = item.status === "running" || item.status === "inProgress";
  const titles = toolTitles(item);

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <span className="flex min-w-0 flex-col items-start gap-1">
            {Array.from(titles, toolTitle.bind(undefined, isFailed))}
          </span>
          {isRunning && <span className="sr-only">Running</span>}
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent onClick={collapseDetail.bind(undefined, setOpen.bind(undefined, false))}>
          <pre className="tool-output">{string(item.text) || "No text output saved."}</pre>
          {item.images && Array.from(item.images, toolImage)}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
