import { type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type AdapterOptions } from "./harness/types";
import { claudeCost, codexCost, piCost, piCostModel, pendingCost, voiceCost } from "../state/cost-observations";
import { observeCost } from "./cost-store";
import { t } from "try";
import { log } from "./logging";

/**
Own an incremental source cursor; restarting safely reimports the same immutable entry identities.
*/
export class PiCosts {
  private cursor = 0;
  private model = { provider: "unknown", model: "unknown" };

  /** Bind native source accounting to its application-owned parent.
  @param parentId - Stable Pocket conversation.
  */
  constructor(private parentId: string) {}

  /** Observe new native records, including compaction and interrupted assistant requests.
  @param entries - Exact native append-only source entries.
  */
  sync(entries: readonly SessionEntry[]) {
    const pending = entries.slice(this.cursor);

    for (const entry of pending) {
      this.model = piCostModel(this.model, entry);
      const record = t(piCost, this.parentId, entry, this.model);

      if (!record.ok) {
        log().warn({ error: record.error }, "costs.native_accounting_failed");
      } else if (record.value) {
        observeCost(record.value);
      }
    }

    this.cursor = entries.length;
  }
}

/** Observe managed native delegates without scanning unrelated local conversations.
@param options - Application-owned delegate relationship.
@param source - Native notification or SDK event.
@param sessionId - Actual native delegate identity.
@param model - Current native model, when the notification does not carry it.
*/
export function observeDelegateCost(options: AdapterOptions, source: unknown, sessionId: string, model: string) {
  const timestamp = new Date().toISOString();
  const record =
    codexCost(options.child.parentId, source, model, timestamp) ??
    claudeCost(options.child.parentId, sessionId, source, timestamp);

  if (record) {
    observeCost(record);
  }
}

/** Reserve voice duration accounting before connecting to the provider.
@param parentId - Owning Pocket.
@param model - Actual requested voice model.
@param sessionId - Application-owned voice session identity.
@returns Pending duration record retained through graceful finalization.
*/
export function startVoiceCost(parentId: string, model: string, sessionId: string) {
  const cost = pendingCost(
    { parentId, feature: "voice", provider: "openai", model },
    `voice:${sessionId}`,
    new Date().toISOString()
  );

  observeCost(cost);

  return cost;
}

/** Retain final voice duration even when ordinary conversation cleanup follows immediately.
@param cost - Original connection attempt, if configuration reached provider dispatch.
@param event - Final session usage.
*/
export function finishVoiceCost(cost: ReturnType<typeof startVoiceCost> | undefined, event: unknown) {
  if (cost) {
    observeCost(voiceCost(cost, event));
  }
}
