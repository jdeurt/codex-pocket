import { pocketForThread } from "../state/pockets";
import { type Config, readConfig } from "./config";
import { pocketStore } from "./pocket-store";

/** Load the configured host and import its original conversation once.
@returns Host configuration shared by named Pockets.
*/
export async function pocketHost() {
  const config = await readConfig();

  if (!config) {
    throw new Error("Configure a thread on your computer first.");
  }

  pocketStore().seed(config.threadId);

  return config;
}

/** Resolve only a saved Pocket and retain host-owned launch and origin policy.
@param id - Saved menu identity, with main retaining the configured original conversation.
@returns Native configuration for this Pocket.
*/
export async function configForPocket(id: string): Promise<Config> {
  const host = await pocketHost();
  const entry = pocketStore().get(id);

  if (entry.state !== "ready" || !entry.threadId) {
    throw new Error("Pocket setup did not finish. Delete this entry and create a new Pocket.");
  }

  return { ...host, threadId: entry.threadId, ...(id !== "main" && { pocketId: id }) };
}

/** Resolve a request's explicit selection without accepting arbitrary native ancestry.
@param request - Authorized request whose tab selection is in its URL.
@returns Saved parent configuration.
*/
export function requestConfig(request: Request) {
  return configForPocket(new URL(request.url).searchParams.get("pocket") ?? "main");
}

/** Resolve a native owner already registered as a main Pocket.
@param owner - Native parent identity from a verified runtime or catalog.
@returns Its saved, host-owned configuration.
*/
export async function configForOwner(owner: string) {
  const host = await pocketHost();
  const entry = pocketForThread(pocketStore().list(), owner);

  if (!entry) {
    throw new Error("Parent chat is unavailable.");
  }

  return { ...host, threadId: owner, ...(entry.id !== "main" && { pocketId: entry.id }) };
}
