import { type PocketSettingsMutation, pocketSettingsSchema } from "../lib/settings";
import { post } from "../lib/client-api";
import { createOperation } from "./operation";
import { type createResources } from "./resources";

/** Save shared settings and update all subscribers from the durable server response.
@param resources - This application's public data cache.
@param url - Explicitly scoped settings endpoint.
@returns Shared mutation state; credentials are sent directly and never stored in client state.
*/
export function createSettingsController(resources: ReturnType<typeof createResources>, url: string) {
  const operation = createOperation();
  const resource = resources.read("/api/settings", pocketSettingsSchema);

  return {
    store: operation.store,
    didSave: async (change: PocketSettingsMutation) => {
      const outcome = await operation.run(
        async () => {
          const data = pocketSettingsSchema.parse(await post(url, change));

          resource.store.setState({ data, error: undefined, isLoading: false });
        },
        "Could not save Pocket settings.",
        "Settings saved."
      );

      return outcome.ok;
    },
  };
}
