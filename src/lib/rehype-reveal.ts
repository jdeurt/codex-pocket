import { type Element, type Root, type RootContent, type Text } from "hast";

interface Reveal {
  source: string;
  from: number;
}
const NOT_FOUND = -1;

/** Split changed literal text without changing the input text node.
@param node - Parser-owned text node.
@param options - Original source and changed source offset.
@returns Existing text or a prefix followed by an animated suffix.
*/
function revealedText(node: Text, options: Reveal): (Text | Element)[] {
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

/** Annotate code geometry without modifying the parser's properties.
@param node - Original code element.
@param options - Original source and changed source offset.
@returns Code element with an optional reveal offset.
*/
function revealedCode(node: Element, options: Reveal): Element {
  let text = "";

  for (const child of node.children) {
    if (child.type === "text") {
      text += child.value;
    }
  }

  text = text.replace(/\n$/, "");
  const start = node.position?.start.offset ?? 0;
  const offset = options.source.slice(start, node.position?.end.offset).indexOf(text);

  return text && offset !== NOT_FOUND
    ? {
        ...node,
        properties: { ...node.properties, "data-pocket-reveal-from": Math.max(0, options.from - start - offset) },
      }
    : node;
}

/** Rebuild changed descendants without mutating the input tree.
@param children - Parser-owned sibling nodes.
@param options - Original source and changed source offset.
@returns New siblings retaining unchanged node identities.
*/
function revealedChildren<T extends RootContent>(children: T[], options: Reveal): (T | Element | Text)[] {
  const next: (T | Element | Text)[] = [];

  for (const child of children) {
    if (child.type === "element") {
      next.push(
        child.tagName === "code"
          ? revealedCode(child, options)
          : {
              ...child,
              children: revealedChildren(child.children, options),
            }
      );
    } else if (child.type === "text" && child.position?.start.offset !== undefined) {
      next.push(...revealedText(child, options));
    } else {
      next.push(child);
    }
  }

  return next;
}

/** Apply reveal annotations to a fresh root.
@param options - Original source and changed source offset.
@param tree - Parser-owned tree.
@returns New tree carrying reveal annotations.
*/
function revealTree(options: Reveal, tree: Root): Root {
  return { ...tree, children: revealedChildren(tree.children, options) };
}

/** Bind explicit source inputs to the framework's transformer signature.
@param options - Original source and changed source offset.
@returns A pure transformer that leaves its input AST unchanged.
*/
export function rehypeReveal(options: Reveal) {
  return revealTree.bind(undefined, options);
}
