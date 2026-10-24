import { remarkCopyAction } from "./remark-copy-action";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const plugins = [[remarkGfm], [remarkGfm, remarkCopyAction]];
const processors = plugins.map((list) =>
  unified().use(remarkParse).use(list).use(remarkRehype, { allowDangerousHtml: true }).freeze()
);

/** Select the same remark plugins used by output detection and Markdown rendering.
@param shouldAllowCopyActions - Whether explicit assistant copy fences are actionable.
@returns The shared plugin list for the requested mode.
*/
export const markdownPlugins = (shouldAllowCopyActions: boolean) => plugins[Number(shouldAllowCopyActions)];

/** Check parser-derived output without retaining mutable global caches.
@param source - Complete or streaming Markdown source to inspect.
@param shouldAllowCopyActions - Whether assistant-only copy markers participate in parsing.
@returns Whether ReactMarkdown can produce a visible node for this source.
*/
export function hasMarkdownOutput(source: string, shouldAllowCopyActions = false) {
  if (!source.trim()) {
    return false;
  }

  const processor = processors[Number(shouldAllowCopyActions)];
  const tree = processor.runSync(processor.parse(source), source);

  for (const node of tree.children) {
    if (node.type === "element" || ((node.type === "text" || node.type === "raw") && !!node.value.trim())) {
      return true;
    }
  }

  return false;
}
