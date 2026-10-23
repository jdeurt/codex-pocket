import { saveSessionSettings, type sessionSettingsSchema } from "./session-settings";
import { type Bridge } from "./bridge-session";
import { type CodexRpc } from "./rpc";
import { contextUsage } from "../lib/usage";
import { delegations } from "./delegations";
import { string } from "../lib/protocol";
import { type z } from "zod";
import { type ModelCatalogQuery } from "./model-catalog-query";

/**
Own the small typed parent control surface while reusing the bridge's transport and snapshot.
*/
export class SessionControls {
  /**
  Bind controls to the configured parent; no native process is created here.
  @param owner - Existing parent connection and canonical state.
  @param exclusive - Parent operation lock shared with message delivery.
  @param publish - Callback publishing confirmed native settings.
  */
  constructor(
    private owner: Bridge,
    private exclusive: <T>(operation: () => Promise<T>) => Promise<T>,
    private publish: () => void
  ) {}

  /**
  Confirm settings through native readback before persisting them for reconnect.
  @param rpc - Existing native transport.
  @param threadId - Server-owned parent identity.
  @returns Current parent control state after persistence.
  */
  private async readback(rpc: CodexRpc, threadId: string) {
    const { thread } = await rpc.request("thread/read", { threadId, includeTurns: false });
    const model = string(thread.model);

    if (!model) {
      throw new Error("Native settings were accepted but readback is unavailable. Inspect before retrying.");
    }

    return this.persist(threadId, model, string(thread.reasoningEffort), thread.harness === "pi");
  }

  /**
  Persist confirmed native settings before exposing them as effective on the phone.
  @param threadId - Owning saved native parent.
  @param model - Confirmed model identifier.
  @param effort - Confirmed reasoning effort, empty when unavailable.
  @param isPi - Whether native delegate defaults must remain independent of Pi catalog choices.
  @returns Current inspection response.
  */
  private async persist(threadId: string, model: string, effort: string, isPi: boolean) {
    const parent = delegations().parent(threadId);

    await saveSessionSettings(threadId, { model, ...(effort && { effort }) });
    const nativeModel = isPi ? parent.policy.model : model;
    const nativeEffort = isPi ? parent.policy.effort : effort || null;

    delegations().saveParent(threadId, {
      ...parent,
      policy: { ...parent.policy, model: nativeModel, effort: nativeEffort },
    });
    this.owner.snapshot.model = model;
    this.owner.snapshot.reasoningEffort = effort || null;
    this.publish();

    return this.info();
  }

  /**
  Apply an allowlisted model/effort mutation while the bridge owns its operation lock.
  @param settings - Explicit validated settings, never permissions or arbitrary native methods.
  @returns Native readback after durable local persistence.
  */
  private async updateConnected(settings: z.infer<typeof sessionSettingsSchema>) {
    const rpc = this.owner.agentReader();
    const threadId = this.owner.snapshot.threadId;

    if (!threadId) {
      throw new Error("Configure a parent chat first.");
    }

    await rpc.request("thread/settings/update", { threadId, ...settings });

    return this.readback(rpc, threadId);
  }

  /**
  Inspect native settings and distinguish recorded token accounting from unknown context occupancy.
  @returns Parent-only settings, lifecycle state and usage provenance.
  */
  info() {
    const state = this.owner.snapshot;

    return {
      threadId: state.threadId,
      model: state.model ?? null,
      effort: state.reasoningEffort ?? null,
      activeTurnId: state.activeTurnId ?? null,
      connection: state.connection,
      executionBoundary: state.executionBoundary ?? "Native harness configuration",
      usage: contextUsage(state.usage),
      lastCompactionAt: state.lastCompactionAt ?? null,
      effectiveFor: "subsequent turns; active work is unchanged",
      persistence: "Pocket saves accepted settings for this parent across reconnects and restarts",
    };
  }

  /**
  Apply model/effort changes using the parent's existing serialized connection.
  @param settings - Validated explicit model and effort fields.
  @returns Native readback after persistence.
  */
  update(settings: z.infer<typeof sessionSettingsSchema>) {
    return this.exclusive(async () => {
      await this.owner.ensureConnected();

      return this.updateConnected(settings);
    });
  }

  /** Read Pi's native provider/model catalog over the existing parent connection.
  @param query - Optional read-only provider/model lookup and pagination.
  @returns Available catalog selections, without credentials or additional inference.
  */
  async models(query: ModelCatalogQuery = {}) {
    await this.owner.ensureConnected();

    return this.owner.agentReader().request("pocket/models", query);
  }
}
