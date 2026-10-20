import { type Item, string } from "../lib/protocol";
import Markdown from "react-markdown";
import { imageUrl } from "../lib/images";

// Use the same Markdown parser as the chat, including reference images and paths
// with spaces. A scoped image request must occur in this owned message's AST.
/**
Collect permitted image sources using the same Markdown AST parser as the chat.
@param text - Exact assistant Markdown, including reference definitions and paths with spaces.
@returns The distinct image sources found by native Markdown URL transformation.
*/
function markdownImageSources(text: string) {
  const sources = new Set<string>();

  Markdown({
    children: text,
    urlTransform: (url, key) => {
      if (key === "src" && imageUrl(url)) {
        sources.add(url);
      }

      return "";
    },
  });

  return sources;
}

/**
Authorize a requested image only when the owned assistant message's Markdown AST contains it.
@param item - Already scoped native item from this agent's saved transcript.
@param requested - Exact image source requested by the read-only endpoint.
@returns The owned source, or undefined when it is not part of the assistant message.
*/
export function markdownImageSource(item: Item, requested: string) {
  if (item.type !== "agentMessage") {
    return;
  }

  return markdownImageSources(string(item.text)).has(requested) ? requested : undefined;
}
