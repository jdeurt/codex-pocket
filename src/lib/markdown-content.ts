import { remarkCopyAction } from "./remark-copy-action";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const plugins = [[remarkGfm], [remarkGfm, remarkCopyAction]];
const processors = plugins.map((list) =>
  unified().use(remarkParse).use(list).use(remarkRehype, { allowDangerousHtml: true })
);
const caches = [new Map<string, boolean>(), new Map<string, boolean>()];
const MAX_CACHED_SOURCES = 4096;

/**
Select the same remark plugins used by output detection and Markdown rendering.
@param shouldAllowCopyActions - Whether explicit assistant copy fences are actionable.
@returns The shared plugin list for the requested mode.
*/
export const markdownPlugins = (shouldAllowCopyActions: boolean) => plugins[Number(shouldAllowCopyActions)];

// Match ReactMarkdown's output tree, including its literal display of raw HTML.
// Definitions can have nonblank source without producing any rendered node.
/**
Check parser-derived output and retain a bounded cache of visible sources.
@param source - Complete or streaming Markdown source to inspect.
@param [shouldAllowCopyActions] - Whether assistant-only copy markers participate in parsing.
@returns Whether ReactMarkdown can produce a visible node for this source.
*/
export function hasMarkdownOutput(source: string, shouldAllowCopyActions = false) {
  if (source.trim()) {
    const mode = Number(shouldAllowCopyActions);
    const cache = caches[mode];

    let visible = cache.get(source);

    if (visible === undefined) {
      const processor = processors[mode];
      const tree = processor.runSync(processor.parse(source), source);

      visible = tree.children.some(
        (node) => node.type === "element" || ((node.type === "text" || node.type === "raw") && !!node.value.trim())
      );
    }

    // Reuse recent sources across snapshots without retaining ASTs.
    cache.delete(source);
    cache.set(source, visible);

    if (cache.size > MAX_CACHED_SOURCES) {
      const oldest = cache.keys().next().value;

      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }

    return visible;
  }

  return false;
}
