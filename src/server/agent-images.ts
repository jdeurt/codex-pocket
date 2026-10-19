import { type Item, string } from "../lib/protocol";
import Markdown from "react-markdown";
import { imageUrl } from "../lib/images";

// Use the same Markdown parser as the chat, including reference images and paths
// with spaces. A scoped image request must occur in this owned message's AST.
export function markdownImageSource(item: Item, requested: string) {
  if (item.type !== "agentMessage") {
    return undefined;
  }

  const sources = new Set<string>();
  Markdown({
    children: string(item.text),
    urlTransform: (url, key) => {
      if (key === "src" && imageUrl(url)) {
        sources.add(url);
      }

      return "";
    },
  });

  return sources.has(requested) ? requested : undefined;
}
