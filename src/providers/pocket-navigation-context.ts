"use client";
import { createContext, useContext } from "react";

export const PocketNavigationContext = createContext("main");

/** Read the explicitly rendered conversation scope without consulting browser location.
@returns Pocket identity supplied by the route or conversation provider.
*/
export function usePocketId() {
  return useContext(PocketNavigationContext);
}
