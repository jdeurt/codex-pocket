import { type Item, string } from "../lib/protocol";
import { type RootContent } from "hast";
import { imageUrl } from "../lib/images";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";

const imageParser = unified().use(remarkParse).use(remarkRehype).freeze();

/** Find a permitted image in the same resolved Markdown AST used by rendering.
@param children - Parsed HTML nodes, left unchanged.
@param requested - Exact source requested by the read-only endpoint.
@returns Whether the source occurs as an image in this tree.
*/
function hasImageSource(children: readonly RootContent[], requested: string): boolean {
  for (const node of children) {
    if (node.type !== "element") {
      continue;
    }

    if (node.tagName === "img" && node.properties.src === requested) {
      return true;
    }

    if (hasImageSource(node.children, requested)) {
      return true;
    }
  }

  return false;
}

/** Authorize a requested image against its owned assistant message's Markdown AST.
@param item - Already scoped native item from this agent's saved transcript.
@param requested - Exact image source requested by the read-only endpoint.
@returns Owned source, or undefined when it is not a permitted image in this message.
*/
export function markdownImageSource(item: Item, requested: string) {
  if (item.type !== "agentMessage" || !imageUrl(requested)) {
    return;
  }

  const text = string(item.text);
  const tree = imageParser.runSync(imageParser.parse(text), text);

  return hasImageSource(tree.children, requested) ? requested : undefined;
}
