import { findById } from "../lib/identity";
import { log } from "./logging";
import { type ClientBootstrap } from "../state/bootstrap";
import { initialSnapshot } from "../lib/protocol";
import { readConfig } from "./config";
import { guard } from "./http";
import { pocketHost } from "./pocket-config";
import { pocketStore } from "./pocket-store";
import { readPocketSettings } from "./pocket-settings";
import { VoiceHistory } from "./voice-history";

/** Load public durable state for one authorized server render; never create a shared React store.
@param request - Actual request headers and explicit Pocket selection.
@returns Serializable initial data used identically by SSR and browser hydration.
*/
export async function readClientBootstrap(request: Request): Promise<ClientBootstrap> {
  await guard(request);
  const pocketId = new URL(request.url).searchParams.get("pocket") ?? "main";
  const initial: ClientBootstrap = {
    pocketId,
    snapshot: structuredClone(initialSnapshot),
    captions: [],
    resources: {},
  };
  const config = await readConfig();

  if (!config) {
    initial.snapshot.connection = "unconfigured";

    return initial;
  }

  await pocketHost();
  // The catalog is loaded from SQLite, not inferred from browser selection.
  const pockets = pocketStore().list();

  initial.resources["/api/pockets"] = { pockets, selectedId: pocketId };
  const selected = findById(pockets, pocketId);

  initial.snapshot.threadId = selected?.threadId ?? undefined;
  initial.snapshot.title = selected?.name ?? "Pocket";
  const [settings, history] = await Promise.allSettled([
    readPocketSettings(),
    selected?.threadId ? new VoiceHistory(selected.threadId).read() : Promise.resolve([]),
  ]);

  if (settings.status === "fulfilled") {
    initial.resources["/api/settings"] = settings.value;
  } else {
    log().warn({ error: settings.reason, pocketId }, "bootstrap.settings_failed");
  }

  if (history.status === "fulfilled") {
    initial.captions = history.value;
  } else {
    log().warn({ error: history.reason, pocketId }, "bootstrap.captions_failed");
  }

  return initial;
}
