"use client";
import { useEffect, useMemo } from "react";
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
  const resource = useMemo(() => resources.read(url, schema), [resources, url, schema]);
  const result = useStore(resource.store);
  const data = useMemo(
    () => (result.data === undefined ? undefined : schema.parse(result.data)),
    [result.data, schema]
  );

  useEffect(() => (isEnabled ? resource.retain() : undefined), [resource, isEnabled]);

  return { ...result, data, url };
}
