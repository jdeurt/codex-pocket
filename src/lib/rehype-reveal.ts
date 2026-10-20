import { type Element, type Root, type Text } from "hast";

/**
Split only newly changed literal text, retaining the parser's Markdown tree and prior text unanimated.
@param options - Exact source and first changed source offset for this incoming update.
@returns A rehype transformer that annotates only changed visible text spans.
*/
export function rehypeReveal(options: { source: string; from: number }) {
  function visit(node: Root | Element) {
    if (node.type === "element" && ["code", "pre"].includes(node.tagName)) {
      return;
    }
    node.children = node.children.flatMap((child) => {
      if (child.type === "element") {
        visit(child);
      }
      if (child.type !== "text" || child.position?.start.offset === undefined) {
        return [child];
      }
      return split(child);
    });
  }

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

  return (tree: Root) => {
    visit(tree);
  };
}
