import { nativeSlot } from "./native-slot";

/**
Render the existing animated placeholder while forwarding native container attributes.
*/
const Skeleton = (nativeSlot<"div">).bind(
  undefined,
  "div",
  "skeleton",
  "animate-pulse rounded-md bg-muted motion-reduce:animate-none"
);

export { Skeleton };
