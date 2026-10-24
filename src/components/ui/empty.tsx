import { nativeSlot } from "./native-slot";

/**
Lay out an empty-state region using the existing centered, bounded composition.
*/
const Empty = (nativeSlot<"div">).bind(
  undefined,
  "div",
  "empty",
  "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance"
);

/**
Group the empty-state heading and description at their shared readable width.
*/
const EmptyHeader = (nativeSlot<"div">).bind(
  undefined,
  "div",
  "empty-header",
  "flex max-w-sm flex-col items-center gap-2"
);

/**
Render an empty-state heading with the shared emphasis and icon alignment.
*/
const EmptyTitle = (nativeSlot<"div">).bind(
  undefined,
  "div",
  "empty-title",
  "font-heading text-sm font-medium tracking-tight"
);

/**
Render empty-state help text while preserving the existing link treatment.
*/
const EmptyDescription = (nativeSlot<"div">).bind(
  undefined,
  "div",
  "empty-description",
  "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary"
);

export { Empty, EmptyDescription, EmptyHeader, EmptyTitle };
