"use client";
import { useEffect, useEffectEvent } from "react";
import { subscribeAppUpdates } from "../services/app-update";

/** Bind update service lifetime to the rendered application without capturing stale readiness.
@param canReload - Reads current UI and durable operation readiness.
*/
export function useAppUpdate(canReload: () => boolean) {
  const isSafe = useEffectEvent(canReload);

  useEffect(() => subscribeAppUpdates(isSafe), []);
}
