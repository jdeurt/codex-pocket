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

export const markdownPlugins = (allowCopyActions: boolean) => plugins[Number(allowCopyActions)];

// Match ReactMarkdown's output tree, including its literal display of raw HTML.
// Definitions can have nonblank source without producing any rendered node.
export function hasMarkdownOutput(source: string, allowCopyActions = false) {
  if (!source.trim()) {
    return false;
  }

  const mode = Number(allowCopyActions);
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
