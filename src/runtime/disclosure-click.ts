import { type MouseEvent } from "react";

const INTERACTIVE =
  "a,button,input,textarea,select,summary,audio,video,[role=button],[role=link],[tabindex],[contenteditable=true]";

/**
Collapse expanded detail content without intercepting controls or text selection.
@param collapse - Callback that closes the owning disclosure.
@param event - Bubbled panel click, including nested Markdown and tool content.
*/
export function collapseDetail(collapse: () => void, event: MouseEvent<HTMLElement>) {
  const target = event.target;
  const interactive = target instanceof Element ? target.closest(INTERACTIVE) : null;

  if (
    event.defaultPrevented ||
    !(target instanceof Element) ||
    !event.currentTarget.contains(target) ||
    (interactive && interactive !== event.currentTarget && event.currentTarget.contains(interactive)) ||
    globalThis.getSelection()?.toString()
  ) {
    return;
  }

  event.stopPropagation();
  collapse();
}
