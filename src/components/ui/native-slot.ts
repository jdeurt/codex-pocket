import { createElement, type ComponentProps } from "react";
import { cn } from "cn";

type NativeTag = "div" | "span" | "p" | "fieldset";

/** Render a native presentation slot with caller attributes and merged classes.
@param tag - Native semantic element.
@param slot - Stable styling slot identity.
@param classes - Shared slot classes.
@param props - Caller-owned native attributes, children and ref.
@returns Native element with caller attributes preserved.
*/
export function nativeSlot<Tag extends NativeTag>(tag: Tag, slot: string, classes: string, props: ComponentProps<Tag>) {
  const { className, ...attributes } = props;

  return createElement(tag, { "data-slot": slot, className: cn(classes, className), ...attributes });
}
