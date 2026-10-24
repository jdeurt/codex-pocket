"use client";
import { agentCatalogSchema, isActiveAgent } from "../lib/agents";
import { useAgentRead } from "./use-agents";

/**
Keep overview polling active and request full catalog details only while the browser is open.
@param isOpen - Whether the list needs the complete scoped catalog.
@returns The newest catalog, its current read error and the active-agent count.
*/
export function useAgentCatalog(isOpen: boolean) {
  const overview = useAgentRead("/api/agents", agentCatalogSchema);
  const detail = useAgentRead("/api/agents?view=list", agentCatalogSchema, isOpen);
  const data =
    overview.data && (!detail.data || overview.data.updatedAt > detail.data.updatedAt) ? overview.data : detail.data;

  return {
    data,
    error: isOpen ? (detail.error ?? overview.error) : overview.error,
    count: overview.error ? 0 : (data?.agents.filter(isActiveAgent).length ?? 0),
  };
}
