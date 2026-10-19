import type { Root } from "mdast";
import type { VFile } from "vfile";

// Only this explicit, closed, top-level fence is actionable. Inspect the original
// source because Markdown also accepts unterminated fences while streaming.
function transformCopyActions(tree: Root, file: VFile) {
  const source = String(file);

  for (const node of tree.children) {
    if (node.type !== "code" || node.lang !== "pocket-copy" || node.meta) {
      continue;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    if (start === undefined || end === undefined || node.position?.start.column !== 1) {
      continue;
    }

    const marker = /^```pocket-copy\r?\n([\s\S]*?)\r?\n```[\t ]*$/.exec(source.slice(start, end));

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
