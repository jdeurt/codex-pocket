import type { Root } from "mdast";
import type { VFile } from "vfile";

// Only this explicit, closed, top-level fence is actionable. Inspect the original
// source because Markdown also accepts unterminated fences while streaming.
function transformCopyActions(tree: Root, file: VFile) {
  const source = String(file);

  for (const node of tree.children) {
    if (node.type !== "code") {
      continue;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    if (start === undefined || end === undefined || node.position?.start.column !== 1) {
      continue;
    }

    const raw = source.slice(start, end);

    if (!node.value.trim() && "```pocket-copy".startsWith(raw.trimEnd())) {
      node.value = raw;
      continue;
    }

    if (node.lang !== "pocket-copy") {
      continue;
    }

    const marker = node.meta ? null : /^```pocket-copy\r?\n([\s\S]*?)\r?\n```[\t ]*$/.exec(raw);

    // A streamed opening fence can have no body yet. Keep its literal source
    // visible instead of producing an empty code box that consumes a flow gap.
    node.value = raw;

    if (!marker) {
      continue;
    }

    try {
      const text: unknown = JSON.parse(marker[1]);

      if (typeof text === "string") {
        node.data = { ...node.data, hProperties: { "data-pocket-copy-text": text } };
      }
    } catch {
      // Partial or malformed payloads remain ordinary code blocks.
    }
  }
}

export function remarkCopyAction() {
  return transformCopyActions;
}
