import { type Item, object, string } from "@/lib/protocol";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "./ui/trace";
import { ChatImage } from "./chat-image";

export function ToolMessage({ item }: { item: Item }) {
  const status =
    item.status === "failed"
      ? "Failed"
      : item.status === "running" || item.status === "inProgress"
        ? "Running"
        : item.status === "completed"
          ? "Completed"
          : "Status unavailable";

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>{string(item.tool) || "Tool"}</TraceTitle>
            <span>{status}</span>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <pre className="tool-output">{string(item.text) || "No text output saved."}</pre>
          {Array.isArray(item.images) &&
            item.images.map((image) => (
              <ChatImage key={string(object(image).source)} source={string(object(image).source)} />
            ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
