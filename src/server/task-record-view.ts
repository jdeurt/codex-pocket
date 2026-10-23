import { type ContextEntry } from "./task-archive";
import { object, string } from "../lib/protocol";

export interface RecordPart {
  label: string;
  text: string;
  callId?: string;
  result?: boolean;
  omitted?: boolean;
}

const PREVIEW_LENGTH = 2000;
const LAST_ENTRY = -1;

/** Remove inline encoded media from reading and search projections, never from retained source.
@param text - Native text, possibly containing inline media.
@returns Text with explicit encoded-payload omission counts.
*/
function readableText(text: string) {
  return text.replaceAll(
    /data:[\w/+.-]+;base64,[\w+/=\r\n]+/gu,
    (value) => `[Inline media omitted: ${String(value.length)} encoded characters; see full source]`
  );
}

/** Extract human-readable content without embedding binary blocks.
@param content - Native string or ordered content blocks.
@returns Complete projected text for search before excerpt limits are applied.
*/
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return Array.isArray(content)
    ? content.map((value) => string(object(value).text) || "[Non-text content omitted; see full source]").join("\n")
    : "";
}

/** Describe native content blocks while keeping calls and results associated by their native IDs.
@param value - Pi or Claude native content block.
@returns A readable projection; unrecognized fields remain available in the source record.
*/
function contentPart(value: unknown): RecordPart {
  const part = object(value);
  const type = string(part.type);

  if (["text", "input_text", "output_text"].includes(type)) {
    return { label: "Text", text: readableText(string(part.text)) };
  }

  if (type === "thinking") {
    return { label: "Thinking", text: readableText(string(part.thinking)) };
  }

  if (["toolCall", "tool_use", "function_call"].includes(type)) {
    return {
      label: `Tool call: ${string(part.name) || "unnamed"}`,
      callId: string(part.id) || string(part.call_id),
      text: readableText(JSON.stringify(part.arguments ?? part.input ?? null)),
    };
  }

  if (type === "tool_result" || type === "function_call_output") {
    return {
      label: part.is_error ? "Tool result (error)" : "Tool result",
      callId: string(part.tool_use_id) || string(part.call_id),
      result: true,
      text: readableText(contentText(part.content ?? part.output)),
    };
  }

  return {
    label: type || "Non-text content",
    text: `Content omitted from preview (${String(JSON.stringify(value).length)} serialized characters); see full source.`,
    omitted: true,
  };
}

/** Describe tool ownership independently of message text.
@param message - Native message or canonical item.
@param role - Normalized source role.
@param id - Stable source identity when a canonical tool item combines call and result.
@returns Tool metadata parts for the reading view.
*/
function toolParts(message: Record<string, unknown>, role: string, id: string): RecordPart[] {
  const parts: RecordPart[] = [];

  if (role === "toolResult" || role === "tool") {
    parts.unshift({
      label: `Tool result: ${string(message.toolName) || string(message.name) || "unnamed"}`,
      callId: string(message.toolCallId) || string(message.tool_call_id),
      result: true,
      text: message.isError ? "Error" : "",
    });
  } else if (["toolTrace", "commandExecution", "mcpToolCall", "dynamicToolCall"].includes(string(message.type))) {
    parts.unshift({
      label: `Tool: ${string(message.tool) || string(message.command) || string(message.type)}`,
      callId: string(message.nativeId) || id,
      text: readableText(string(message.aggregatedOutput) || string(message.output)),
    });
  }

  if (["function_call", "function_call_output"].includes(string(message.type))) {
    parts.unshift(contentPart(message));
  }

  return parts;
}

/** Project saved Pi messages, Claude blocks and canonical Codex items without changing source identity.
@param entry - Exact archived record.
@returns Ordered display parts, timestamp and provider when the source supplies them.
*/
export function recordView(entry: ContextEntry) {
  const original = object(entry.original);
  const message = original.message ? object(original.message) : original;
  const content = message.content;
  const role = string(message.role) || entry.role;
  const parts: RecordPart[] = [];

  if (Array.isArray(content)) {
    parts.push(...content.map((part) => contentPart(part)));
  } else if (typeof content === "string") {
    parts.push({ label: "Text", text: readableText(content) });
  } else if (entry.text) {
    parts.push({ label: "Text", text: readableText(entry.text) });
  }

  parts.unshift(...toolParts(message, role, entry.id));

  const timestamp = original.timestamp ?? message.timestamp;

  return {
    parts,
    timestamp: typeof timestamp === "string" || typeof timestamp === "number" ? String(timestamp) : null,
    provider: string(message.provider) || string(original.source) || null,
  };
}

/** Limit a text preview and state exactly how much of the projected text was omitted.
@param text - Complete readable text.
@param limit - Maximum displayed grapheme clusters.
@returns Bounded text and an explicit truncation count, if necessary.
*/
export function compactText(text: string, limit = PREVIEW_LENGTH) {
  const characters = Array.from(
    new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
    (part) => part.segment
  );

  return characters.length <= limit
    ? text
    : characters.slice(0, limit).join("") +
        `\n[Truncated: ${String(characters.length - limit)} of ${String(characters.length)} characters omitted; see full source.]`;
}

/** Encode a real local path for a Markdown link without manufacturing a source location.
@param file - Existing or durably written source path.
@returns Markdown link destination safe for spaces and delimiters.
*/
export function sourceLink(file: string) {
  return `<${encodeURI(file).replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("#", "%23")}>`;
}

/** Render chronological message groups with backward references for interleaved tool results.
@param entries - Source envelope in sequence order.
@param sourceFile - Resolver for the exact retained record file.
@returns Markdown timeline with bounded record previews and native provenance.
*/
export function taskTimeline(entries: ContextEntry[], sourceFile: (entry: ContextEntry) => string) {
  const calls = new Map<string, ContextEntry[]>();
  const lines: string[] = [];

  for (const entry of entries) {
    const view = recordView(entry);

    if (entry.role === "user" && view.parts.some((part) => !part.result)) {
      lines.push(`## User message ${String(entry.sequence)}`, "");
    }

    lines.push(
      `### ${String(entry.sequence)} · ${entry.role}`,
      "",
      `Source ID: ${JSON.stringify(entry.id)} · Sequence: ${String(entry.sequence)}`,
      `Timestamp: ${view.timestamp ?? "not recorded"}${view.provider ? ` · Provider: ${view.provider}` : ""}`,
      `[Full source record](${sourceLink(sourceFile(entry))})`,
      ""
    );

    const projected: string[] = [];

    for (const part of view.parts) {
      projected.push(`${part.label}${part.callId ? ` · Call ID: ${part.callId}` : ""}`, part.text);

      if (part.callId && part.result) {
        const matches = calls.get(part.callId) ?? [];
        const call = matches.at(LAST_ENTRY);

        lines.push(
          call && matches.length === 1
            ? `Result of source ${JSON.stringify(call.id)}: [tool call](${sourceLink(sourceFile(call))}).`
            : `Call ${JSON.stringify(part.callId)}: ${matches.length > 1 ? "ambiguous" : "not present in this envelope"}.`,
          ""
        );
      } else if (part.callId) {
        calls.set(part.callId, [...(calls.get(part.callId) ?? []), entry]);
      }
    }

    const text = compactText(projected.join("\n\n") || "No text content; see full source.");

    // Indentation keeps source Markdown/backticks from becoming archive structure or executable links.
    lines.push(...text.split("\n").map((line) => `    ${line}`), "");
  }

  return lines.join("\n");
}
