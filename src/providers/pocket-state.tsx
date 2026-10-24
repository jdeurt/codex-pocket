"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPocketClient, type PocketClient } from "../services/pocket-client";
import { type ClientBootstrap } from "../state/bootstrap";

const PocketContext = createContext<PocketClient | null>(null);

/** Give this rendered request a fresh store, then start browser services after hydration.
@param props - Matching server/client seed and rendered children.
@returns Scoped state owner; remount with a new key when Pocket identity changes.
*/
export function PocketStateProvider({ initial, children }: { initial: ClientBootstrap; children: ReactNode }) {
  const [client] = useState(() => createPocketClient(initial));

  useEffect(() => client.connect(), [client]);

  return <PocketContext value={client}>{children}</PocketContext>;
}

/** Access services scoped to the current rendered Pocket, never a module-global singleton.
@returns This provider's state owners and lifecycle actions.
*/
export function usePocketClient() {
  const client = useContext(PocketContext);

  if (!client) {
    throw new Error("Pocket state requires PocketStateProvider.");
  }

  return client;
}
