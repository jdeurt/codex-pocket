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

const statusLabels = new Map([
  ["failed", "Failed"],
  ["running", "Running"],
  ["inProgress", "Running"],
  ["completed", "Completed"],
]);

/**
Present shared native tool text, errors and image output without executing display data.
@param props - Normalized tool-trace item from the shared native adapter.
@returns The existing activity line and optional expandable output.
*/
export function ToolMessage({ item }: { item: Item }) {
  const status = statusLabels.get(string(item.status)) ?? "Status unavailable";

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
          {item.images?.map((image) => (
            <ChatImage key={image.source} source={image.source} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
