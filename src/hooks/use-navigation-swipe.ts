"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useBoundCallback } from "./use-bound-callback";
import { connectNavigationSwipe, updateSwipeActions } from "../runtime/navigation-swipe";

/** Bind swipe navigation to the currently visible screen.
@param isEnabled - Whether this surface owns navigation.
@param left - Action for a right-to-left swipe.
@param right - Action for a left-to-right swipe.
@returns Ref for the screen's root element.
*/
export function useNavigationSwipe<Element extends HTMLElement = HTMLDivElement>(
  isEnabled: boolean,
  left?: () => void,
  right?: () => void
) {
  const [surface, setSurface] = useState<Element | null>(null);
  const actions = useRef({ left, right });
  const updateActions = useBoundCallback(updateSwipeActions, actions, left, right);
  const connect = useBoundCallback(connectNavigationSwipe, surface, isEnabled, actions);

  useLayoutEffect(updateActions, [updateActions]);
  useLayoutEffect(connect, [connect]);

  return setSurface;
}
