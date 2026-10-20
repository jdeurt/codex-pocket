"use client";
import { Component, type ReactNode, type RefObject } from "react";

interface SavedSelection {
  anchor: number;
  focus: number;
  text: string;
}
interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

/**
Translate a native selection endpoint into an exact rendered-text offset before React mutates it.
@param element - Shared Markdown root containing the endpoint.
@param node - Native anchor or focus node.
@param offset - Native offset within that node.
@returns Character offset in the rendered root, with no Markdown source transformations.
*/
function textOffset(element: HTMLElement, node: Node, offset: number) {
  const range = element.ownerDocument.createRange();

  range.selectNodeContents(element);
  range.setEnd(node, offset);

  return range.toString().length;
}

/**
Capture only a nonempty selection fully owned by this Markdown surface.
@param element - Mounted shared Markdown root.
@returns Directional offsets and original selected text, or null for an unrelated selection.
*/
function captureSelection(element: HTMLElement | null): SavedSelection | null {
  const selection = element?.ownerDocument.getSelection();

  if (
    !element ||
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !element.contains(selection.anchorNode) ||
    !element.contains(selection.focusNode)
  ) {
    return null;
  }

  return {
    anchor: textOffset(element, selection.anchorNode, selection.anchorOffset),
    focus: textOffset(element, selection.focusNode, selection.focusOffset),
    text: selection.toString(),
  };
}

/**
Locate one prior text offset in the updated Markdown tree without changing its contents.
@param element - Updated shared Markdown root.
@param offset - Rendered-text offset captured before mutation.
@returns Native text-node endpoint, or null if the updated content no longer contains it.
*/
function endpoint(element: HTMLElement, offset: number) {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  let remaining = offset;
  let node = walker.nextNode();

  while (node) {
    const length = node.textContent?.length ?? 0;

    if (remaining <= length) {
      return { node, offset: remaining };
    }

    remaining -= length;
    node = walker.nextNode();
  }

  return null;
}

/**
Restore selection direction only if its exact text survives the incoming update.
@param element - Updated shared Markdown root.
@param saved - Pre-mutation native selection owned by this root.
*/
function restoreSelection(element: HTMLElement | null, saved: SavedSelection | null) {
  const text = element?.textContent ?? "";
  const start = saved ? Math.min(saved.anchor, saved.focus) : 0;
  const end = saved ? Math.max(saved.anchor, saved.focus) : 0;
  const anchor = element && saved ? endpoint(element, saved.anchor) : null;
  const focus = element && saved ? endpoint(element, saved.focus) : null;

  if (saved && element && anchor && focus && text.slice(start, end) === saved.text) {
    element.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }
}

/**
Use React's pre-mutation lifecycle to retain selection through Markdown text-node replacement.
*/
export class MarkdownSelection extends Component<Props, Record<string, never>, SavedSelection | null> {
  /**
  Read selection before React replaces or splits existing literal text nodes.
  @returns This root's exact native selection before DOM mutation.
  */
  getSnapshotBeforeUpdate() {
    return captureSelection(this.props.containerRef.current);
  }

  /**
  Restore still-valid selected text immediately after the DOM update, before painting.
  @param _previous - Prior renderer props, unused because offsets own the captured state.
  @param _state - Unused component state.
  @param saved - Selection captured before this exact update.
  */
  componentDidUpdate(_previous: Props, _state: Record<string, never>, saved: SavedSelection | null) {
    restoreSelection(this.props.containerRef.current, saved);
  }

  /**
  Keep the existing Markdown root and animation ref, adding no wrapper geometry.
  @returns The shared Markdown surface.
  */
  render() {
    return (
      <div ref={this.props.containerRef} className="markdown">
        {this.props.children}
      </div>
    );
  }
}
