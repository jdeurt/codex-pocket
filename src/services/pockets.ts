import { pocketHref, pocketsSchema } from "../lib/pockets";
import { post } from "../lib/client-api";
import { createOperation } from "./operation";
import { type createResources } from "./resources";

export interface PocketEdit {
  action: "create" | "rename" | "delete";
  id: string;
  name: string;
}

/** Own durable catalog mutations independently of the menu's local editor state.
@param resources - Shared catalog and read owners.
@param selectedId - Selected Pocket whose deletion requires navigation.
@param url - Explicit catalog endpoint.
@returns Mutation state and a save action preserving the caller's idempotency identity.
*/
export function createPocketsController(
  resources: ReturnType<typeof createResources>,
  selectedId: string,
  url: string
) {
  const operation = createOperation();
  const resource = resources.read("/api/pockets", pocketsSchema);

  return {
    store: operation.store,
    clearError: () => {
      operation.store.setState({ error: "" });
    },
    save: (change: PocketEdit) =>
      operation.run(async () => {
        const result = await post(url, change.action === "delete" ? { action: change.action, id: change.id } : change);
        const entries = pocketsSchema.shape.pockets.parse(result.pockets);
        const created = entries.find((entry) => entry.id === change.id);

        resource.store.setState({ data: { pockets: entries, selectedId }, error: undefined, isLoading: false });

        if (change.action === "create" && created?.state !== "ready") {
          throw new Error("Setup did not finish. Delete this entry before trying a new Pocket.");
        }

        if (!(change.action === "create" || (change.action === "delete" && change.id === selectedId))) {
          return;
        }

        const destination =
          change.action === "create" ? change.id : (entries.find((entry) => entry.state === "ready")?.id ?? "main");

        location.assign(pocketHref(destination));
      }, "Could not save this Pocket."),
  };
}
