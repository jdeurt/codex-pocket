import { type Data, type Item, object, string } from "../lib/protocol";
import { commandPreview } from "../lib/tool-label";

const FILE_VERBS = new Map([
  ["add", "Created"],
  ["create", "Created"],
  ["update", "Edited"],
  ["edit", "Edited"],
  ["delete", "Deleted"],
]);

/**
Retain the operation and path for every native file-change entry.
@param changes - Native file-change collection, never inferred from output text.
@returns Safe display-only file labels in native order.
*/
function fileLabels(changes: unknown) {
  const labels: string[] = [];

  if (Array.isArray(changes)) {
    for (const entry of changes) {
      const change = object(entry);
      const verb = FILE_VERBS.get(string(object(change.kind).type) || string(change.kind));
      const path = string(change.path);

      if (verb && path) {
        labels.push(`${verb} ${path}`);
      }
    }
  }

  return labels;
}

/**
Project only explicit command and file metadata, excluding unrelated private tool arguments.
@param item - Native Codex item or canonical saved tool trace.
@returns Meaningful native labels, or an empty list for the generic tool-name fallback.
*/
export function toolPreview(item: Item): string[] {
  if (Array.isArray(item.toolLabels)) {
    const labels: string[] = [];

    for (const label of item.toolLabels) {
      if (typeof label === "string") {
        labels.push(label);
      }
    }

    return labels;
  }

  if (item.type === "commandExecution" && typeof item.command === "string") {
    return [`Executed ${commandPreview(item.command)}`];
  }

  return item.type === "fileChange" ? fileLabels(item.changes) : [];
}

/**
Extract explicit native command and edit targets before private input leaves the host boundary.
@param name - Native Claude or Pi tool name.
@param input - Native tool input retained only on the computer.
@returns Display-only labels without copying the input object into the snapshot.
*/
export function inputToolPreview(name: string, input: Data): string[] {
  const tool = name.toLowerCase();

  if (tool === "bash" && typeof input.command === "string") {
    return [`Executed ${commandPreview(input.command)}`];
  }

  const path = string(input.file_path) || string(input.path);

  // Write can replace an existing file; its input alone cannot establish creation.
  return path && ["edit", "multiedit"].includes(tool) ? [`Edited ${path}`] : [];
}
