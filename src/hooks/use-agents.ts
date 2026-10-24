"use client";
import { useEffect } from "react";
import { inactiveSubscription } from "../runtime/events";
import { useStore } from "zustand";
import { type ZodType } from "zod";
import { usePocketClient } from "../providers/pocket-state";

/** Subscribe to a shared scoped resource; services own requests, retries and invalidation.
@param url - Endpoint relative to the selected Pocket.
@param schema - Runtime validator for hydrated and live data.
@param isEnabled - Whether this mounted view currently needs updates.
@returns Last valid data plus loading and failure state.
*/
export function useAgentRead<T>(url: string, schema: ZodType<T>, isEnabled = true) {
  const { resources } = usePocketClient();
  const resource = resources.read(url, schema);
  const result = useStore(resource.store);
  const retain = isEnabled ? resource.retain : inactiveSubscription;

  useEffect(retain, [retain]);

  return { ...result, url };
}
