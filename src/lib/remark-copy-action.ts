import type { Code, Root } from "mdast";
import type { VFile } from "vfile";
import { z } from "zod";
import { t as attempt } from "try";

const copyTextSchema = z.string();

/** Validate a serialized copy payload without coercing its value.
@param source - Exact JSON payload between closed fence markers.
@returns Decoded text or a validation failure.
*/
function copyText(source: string) {
  return copyTextSchema.parse(JSON.parse(source));
}

/** Return literal or actionable code without changing the parser-owned node.
@param node - Code node with optional source positions.
@param source - Original complete or streaming Markdown.
@returns Original node or a replacement with exact copy-fence content.
*/
function copyCode(node: Code, source: string): Code {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;

  if (start === undefined || end === undefined || node.position?.start.column !== 1) {
    return node;
  }

  const raw = source.slice(start, end);

  if (!node.value.trim() && "```pocket-copy".startsWith(raw.trimEnd())) {
    return { ...node, value: raw };
  }

  if (node.lang !== "pocket-copy") {
    return node;
  }

  const literal = { ...node, value: raw };
  const marker = node.meta ? null : /^```pocket-copy\r?\n([\s\S]*?)\r?\n```[\t ]*$/.exec(raw);

  if (!marker) {
    return literal;
  }

  const payload = attempt(copyText, marker[1]);

  return payload.ok
    ? { ...literal, data: { ...node.data, hProperties: { "data-pocket-copy-text": payload.value } } }
    : literal;
}

/** Replace eligible code while retaining every other parser node.
@param source - Original Markdown source.
@param node - Parser-owned top-level node.
@returns Original node or an independently annotated code node.
*/
function copiedNode(source: string, node: Root["children"][number]) {
  return node.type === "code" ? copyCode(node, source) : node;
}

/** Transform closed top-level copy fences while preserving the original AST.
@param tree - Parser-owned Markdown AST.
@param file - Original source distinguishes closed fences from streaming fragments.
@returns A new root with replacements only for code nodes.
*/
function transformCopyActions(tree: Root, file: VFile): Root {
  const source = String(file);
  const children = Array.from(tree.children, copiedNode.bind(undefined, source));

  return { ...tree, children };
}

/** Install the pure transformer for exact assistant copy payloads.
@returns The remark transformer.
*/
export function remarkCopyAction() {
  return transformCopyActions;
}
