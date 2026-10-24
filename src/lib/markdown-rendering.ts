import { type Element } from "hast";

/** Read literal code text from parser-owned child nodes.
@param node - Optional code element.
@returns Joined text with the parser's final newline removed.
*/
export function literalCodeText(node?: Element) {
  let text = "";

  const children = node?.children ?? [];

  for (const child of children) {
    if (child.type === "text") {
      text += child.value;
    }
  }

  return text.replace(/\n$/, "");
}

/** Recognize paragraphs containing only images and spacing.
@param node - Parser-owned paragraph, when supplied.
@returns Whether attachment composition can replace the paragraph wrapper.
*/
export function isImageParagraph(node?: Element) {
  if (!node) {
    return false;
  }

  for (const child of node.children) {
    const isImage = child.type === "element" && child.tagName === "img";
    const isSpacing = child.type === "text" && !child.value.trim();

    if (!isImage && !isSpacing) {
      return false;
    }
  }

  return true;
}
