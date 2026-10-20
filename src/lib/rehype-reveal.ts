import { type Element, type Root, type Text } from "hast";

const NOT_FOUND = -1;

/**
Split only newly changed literal text, retaining the parser's Markdown tree and prior text unanimated.
@param options - Exact source and first changed source offset for this incoming update.
@returns A rehype transformer that annotates only changed visible text spans.
*/
export function rehypeReveal(options: { source: string; from: number }) {
  function split(node: Text): (Text | Element)[] {
    const start = node.position?.start.offset ?? 0;
    const prefix = Math.max(0, options.from - start);

    if (prefix >= node.value.length || options.source.slice(start, start + node.value.length) !== node.value) {
      return [node];
    }

    return [
      { type: "text", value: node.value.slice(0, prefix) },
      {
        type: "element",
        tagName: "span",
        properties: { "data-pocket-fresh": "" },
        children: [{ type: "text", value: node.value.slice(prefix) }],
      },
    ];
  }

  function visit(node: Root | Element) {
    if (node.type === "element" && node.tagName === "code") {
      const text = node.children
        .filter((child) => child.type === "text")
        .map((child) => child.value)
        .join("")
        .replace(/\n$/, "");
      const start = node.position?.start.offset ?? 0;
      const region = options.source.slice(start, node.position?.end.offset);
      const offset = region.indexOf(text);

      if (text && offset !== NOT_FOUND) {
        node.properties["data-pocket-reveal-from"] = Math.max(0, options.from - start - offset);
      }

      return;
    }

    node.children = node.children.flatMap((child) => {
      if (child.type === "element") {
        visit(child);
      }

      return child.type !== "text" || child.position?.start.offset === undefined ? [child] : split(child);
    });
  }

  return (tree: Root) => {
    visit(tree);
  };
}
