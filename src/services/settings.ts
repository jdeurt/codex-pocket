import { type PocketSettingsMutation, pocketSettingsSchema } from "../lib/settings";
import { post } from "../runtime/client-api";
import { Operation } from "./operation";
import { type Resources } from "./resources";

/** Persist settings and publish the validated response at the service boundary.
@param resources - Scoped resource runtime.
@param url - Settings API endpoint.
@param change - User-requested mutation.
*/
async function saveSettings(resources: Resources, url: string, change: PocketSettingsMutation) {
  const data = pocketSettingsSchema.parse(await post(url, change));

  resources.read("/api/settings", pocketSettingsSchema).store.setState({ data, error: undefined, isLoading: false });
}

/**
Runtime owner of settings effects; secrets never enter observable state.
*/
export class SettingsController {
  private readonly operation = new Operation();
  readonly store = this.operation.store;

  /** Execute a settings mutation with explicit service arguments.
  @param change - User-requested settings.
  @returns Whether durable storage accepted the change.
  */
  didSave = async (change: PocketSettingsMutation) => {
    const outcome = await this.operation.run(
      saveSettings,
      "Could not save Pocket settings.",
      "Settings saved.",
      this.resources,
      this.url,
      change
    );

    return outcome.ok;
  };

  /** Bind an effectful owner to one scoped endpoint.
  @param resources - Shared resource runtime.
  @param url - Scoped settings URL.
  */
  constructor(
    private readonly resources: Resources,
    private readonly url: string
  ) {}
}
