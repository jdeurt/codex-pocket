import { resourceState } from "../state/resource";
import { createDraftStore, editDraft } from "../runtime/draft";
import { observable } from "../runtime/stores";
import { browserDraftStorage } from "./draft-storage";
import { t as attempt } from "try";

/** Read durable text at the browser boundary.
@param key - Scoped storage identity.
@param text - Current draft projection.
@returns Whether the browser contains this exact text.
*/
function isStored(key: string, text: string) {
  return (localStorage.getItem(key) ?? "") === text;
}

/**
Runtime owner of hydration, cross-tab listeners and draft publication.
*/
export class DraftController {
  private readonly key: string;

  /** Rehydrate when this tab's storage key changes.
  @param event - Browser storage notification.
  */
  private changed = (event: StorageEvent) => {
    if (event.key === this.key || event.key === null) {
      void this.hydrate();
    }
  };

  /** Read durable state through Zustand's revision-fenced hydration.
  @returns Completion after hydration status is published.
  */
  private hydrate = async () => {
    await this.store.persist.rehydrate();
    const hasHydrated = this.store.persist.hasHydrated();

    this.hydration.setState({
      data: hasHydrated,
      isLoading: false,
      error: hasHydrated ? undefined : "Saved draft could not be restored on this device.",
    });
  };

  /**
  Release exactly the listener registered by this owner.
  */
  private disconnect = () => {
    globalThis.removeEventListener("storage", this.changed);
  };

  readonly store;
  readonly hydration = observable(resourceState<boolean>());

  /** Check durable text before allowing a page reload.
  @returns Whether reloading can preserve the current draft.
  */
  isSaved = () => {
    const text = this.store.getState().text;
    const outcome = attempt(isStored, this.key, text);

    return outcome.ok ? outcome.value : text === "";
  };

  /** Publish a pure edit and report persistence failure independently.
  @param text - New user-entered text.
  */
  setText = (text: string) => {
    const saved = attempt(editDraft, this.store, text);

    this.hydration.setState({ error: saved.ok ? undefined : "Draft could not be saved on this device." });
  };

  /** Start browser hydration and cross-tab synchronization after mount.
  @returns Cleanup for this owner's subscription.
  */
  connect = () => {
    void this.hydrate();
    globalThis.addEventListener("storage", this.changed);

    return this.disconnect;
  };

  /** Allocate state without accessing browser storage during SSR.
  @param pocketId - Explicit identity fixed for this owner's lifetime.
  */
  constructor(pocketId: string) {
    this.key = pocketId === "main" ? "codex-pocket-draft" : `codex-pocket-draft:${pocketId}`;
    this.store = createDraftStore(this.key, browserDraftStorage());
  }
}
