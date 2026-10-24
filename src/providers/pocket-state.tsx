"use client";
import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import { PocketNavigationContext } from "./pocket-navigation-context";
import { ContentRevealContext } from "./content-reveal-context";
import { PocketClient } from "../services/pocket-client";
import { type ClientBootstrap } from "../state/bootstrap";

const PocketContext = createContext<PocketClient | null>(null);

/** Allocate the runtime for React's lazy state initializer.
@param initial - Serialized bootstrap for this rendered Pocket.
@returns Isolated effect owner without starting browser work.
*/
function initializePocket(initial: ClientBootstrap) {
  return new PocketClient(initial);
}

/** Retain the mounted runtime; a different Pocket is represented by a new provider key.
@param client - Runtime owned by this provider.
@returns The same runtime without running effects.
*/
function retainPocket(client: PocketClient) {
  return client;
}

/** Give this rendered request a fresh store, then start browser services after hydration.
@param props - Matching server/client seed and rendered children.
@returns Scoped state owner; remount with a new key when Pocket identity changes.
*/
export function PocketStateProvider({ initial, children }: { initial: ClientBootstrap; children: ReactNode }) {
  const [client] = useReducer(retainPocket, initial, initializePocket);

  const { connect } = client;

  useEffect(connect, [connect]);

  return (
    <PocketContext value={client}>
      <PocketNavigationContext value={initial.pocketId}>
        <ContentRevealContext value={client.reveals}>{children}</ContentRevealContext>
      </PocketNavigationContext>
    </PocketContext>
  );
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
