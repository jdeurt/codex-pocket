"use client";
import { useContext, useEffect, useRef, useState } from "react";
import { ContentRevealContext } from "../providers/content-reveal-context";
import { ContentReveals } from "../runtime/content-reveal";

/** Allocate an isolated fallback for Markdown rendered outside a conversation.
@returns Animation owner used by standalone file views.
*/
function createReveals() {
  return new ContentReveals();
}

/** Bind the mounted Markdown element to its Pocket's animation runtime.
@param revision - Incoming source-change identity, absent for loaded history.
@returns Container ref consumed by the rendering component.
*/
export function useContentReveal(revision?: string) {
  const shared = useContext(ContentRevealContext);
  const [local] = useState(createReveals);
  const reveals = shared ?? local;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(reveals.connect.bind(undefined, ref, revision), [reveals, ref, revision]);

  return ref;
}
