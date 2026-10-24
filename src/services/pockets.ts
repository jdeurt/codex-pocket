import { pocketHref, pocketsSchema } from "../lib/pockets";
import { post } from "../runtime/client-api";
import { Operation } from "./operation";
import { type Resources } from "./resources";
import { pocketDestination, type PocketEdit } from "../state/pockets";

export type { PocketEdit } from "../state/pockets";

/**
Runtime owner of catalog persistence and explicit browser navigation effects.
*/
export class PocketsController {
  private readonly operation = new Operation();

  /** Persist a catalog edit before executing its pure navigation decision.
  @param change - Explicit user-requested mutation.
  */
  private persist = async (change: PocketEdit) => {
    const body = change.action === "delete" ? { action: change.action, id: change.id } : change;
    const result = await post(this.url, body);
    const entries = pocketsSchema.shape.pockets.parse(result.pockets);

    this.resources.read("/api/pockets", pocketsSchema).store.setState({
      data: { pockets: entries, selectedId: this.selectedId },
      error: undefined,
      isLoading: false,
    });
    const destination = pocketDestination(change, this.selectedId, entries);

    if (destination !== undefined) {
      location.assign(pocketHref(destination));
    }
  };

  readonly store = this.operation.store;

  /**
  Clear the prior mutation error when the user edits the form.
  */
  clearError = () => {
    this.store.setState({ error: "" });
  };

  /** Serialize one catalog mutation while retaining its user-provided idempotency identity.
  @param change - Requested catalog mutation.
  @returns Operation outcome after persistence and any required navigation.
  */
  save = (change: PocketEdit) => this.operation.run(this.persist, "Could not save this Pocket.", "", change);

  /** Retain explicit catalog dependencies without starting network work.
  @param resources - Shared runtime cache.
  @param selectedId - Selected Pocket whose deletion requires navigation.
  @param url - Scoped catalog endpoint.
  */
  constructor(
    private readonly resources: Resources,
    private readonly selectedId: string,
    private readonly url: string
  ) {}
}
