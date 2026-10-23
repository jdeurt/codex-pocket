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
import { collapseDetail } from "@/lib/disclosure-click";
import { toolName } from "@/lib/tool-label";
import { useState } from "react";

/**
Present shared native tool text, errors and image output without executing display data.
@param props - Normalized tool-trace item from the shared native adapter.
@returns The existing activity line and optional expandable output.
*/
export function ToolMessage({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const isFailed = item.status === "failed";
  const isRunning = item.status === "running" || item.status === "inProgress";
  const labels = Array.isArray(item.toolLabels) ? item.toolLabels.filter((label) => typeof label === "string") : [];
  const titles = [...new Set(labels.length > 0 ? labels : [toolName(string(item.tool))])];

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <span className="flex min-w-0 flex-col items-start gap-1">
            {titles.map((title) => (
              <TraceLine key={title} status={isFailed ? "error" : undefined}>
                {isFailed && <XIcon aria-hidden="true" className="size-3 shrink-0" />}
                {isFailed && <span className="sr-only">Failed: </span>}
                <TraceTitle>{title}</TraceTitle>
              </TraceLine>
            ))}
          </span>
          {isRunning && <span className="sr-only">Running</span>}
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent
          onClick={(event) => {
            collapseDetail(event, () => {
              setOpen(false);
            });
          }}
        >
          <pre className="tool-output">{string(item.text) || "No text output saved."}</pre>
          {item.images?.map((image) => (
            <ChatImage key={image.source} source={image.source} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
