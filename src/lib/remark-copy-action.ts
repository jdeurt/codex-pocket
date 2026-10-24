import type { Code, Root } from "mdast";
import type { VFile } from "vfile";
import { z } from "zod";
import { t as attempt } from "try";

const copyTextSchema = z.string();

/**
Validate a closed copy fence and attach only its exact decoded string payload.
@param node - Code node whose literal fallback has already been restored.
@param raw - Exact source text of its top-level fence.
*/
function annotateCopyFence(node: Code, raw: string) {
  const marker = node.meta ? null : /^```pocket-copy\r?\n([\s\S]*?)\r?\n```[\t ]*$/.exec(raw);

  if (!marker) {
    return;
  }

  const outcome = attempt(() => {
    const text = copyTextSchema.parse(JSON.parse(marker[1]));

    node.data = { ...node.data, hProperties: { "data-pocket-copy-text": text } };
  });

  if (!outcome.ok) {
    // Partial or malformed payloads remain ordinary code blocks.
  }
}

/**
Keep copy fences literal until a complete payload can become an explicit copy action.
@param node - Mutable code node from the parser.
@param raw - Its exact source, including opening/closing fence text.
*/
function rewriteCopyFence(node: Code, raw: string) {
  if (!node.value.trim() && "```pocket-copy".startsWith(raw.trimEnd())) {
    node.value = raw;

    return;
  }

  if (node.lang !== "pocket-copy") {
    return;
  }

  node.value = raw;
  annotateCopyFence(node, raw);
}

/**
Read a top-level code fence only when its source offsets describe an unindented fence.
@param node - Code node whose source positions may be absent.
@param source - Original Markdown source, without normalization.
*/
function transformCopyCode(node: Code, source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;

  if (start === undefined || end === undefined || node.position?.start.column !== 1) {
    return;
  }

  rewriteCopyFence(node, source.slice(start, end));
}

// Only this explicit, closed, top-level fence is actionable. Inspect the original
// source because Markdown also accepts unterminated fences while streaming.
/**
Mark only closed top-level copy fences with a validated exact string payload.
@param tree - Mutable Markdown AST whose code nodes receive copy-action metadata.
@param file - Original source needed to distinguish closed fences from streaming fragments.
*/
function transformCopyActions(tree: Root, file: VFile) {
  const source = String(file);

  for (const node of tree.children) {
    if (node.type !== "code") {
      continue;
    }

    transformCopyCode(node, source);
  }
}

/**
Install the assistant-only transformer that retains literal malformed and streaming fences.
@returns The remark transformer for exact copy payloads.
*/
export function remarkCopyAction() {
  return transformCopyActions;
}
