"use client";
import { type RefObject, useEffect } from "react";
import { connectComposerViewport } from "../runtime/composer-viewport";

/** Bind the mounted composer to its explicit browser viewport owner.
@param textarea - Stable ref to the current composer textarea.
*/
export function useComposerViewport(textarea: RefObject<HTMLTextAreaElement | null>) {
  useEffect(connectComposerViewport.bind(undefined, textarea), [textarea]);
}
