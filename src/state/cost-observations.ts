import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { z } from "zod";
import { object, string } from "../lib/protocol";
import type { CostObservation, CostScope } from "../lib/costs";

const modelPriceSchema = z.object({
  id: z.string(),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
});
const MILLION = 1_000_000;
const SECONDS_PER_MINUTE = 60;
const DECISION_INPUT_RATE = 0.1;
const DECISION_CACHE_RATE = 0.01;
const DECISION_WRITE_RATE = 0.125;
const LIVE_MINUTE_RATE = 0.05;
const PRICING_DATE = "2026-10-26";
const DECISION_PRICING = `https://developers.openai.com/api/docs/guides/decisions (${PRICING_DATE}; standard, 30m cache writes)`;
const LIVE_PRICING = `https://developers.openai.com/api/docs/models/gpt-live-1 (${PRICING_DATE})`;
const CATALOG_PRICING = "Pi model catalog (@earendil-works/pi-ai 1.4.0); API-equivalent estimate";

export interface PiCostModel {
  provider: string;
  model: string;
}

const UNKNOWN_PI_MODEL = { provider: "unknown", model: "unknown" };

/** Follow native model-selection records for summary entries that omit model identity.
@param previous - Explicit prior native model selection.
@param source - Native source entry.
@returns Current recorded model identity.
*/
export function piCostModel(previous: PiCostModel, source: unknown): PiCostModel {
  const entry = object(source);

  return entry.type === "model_change"
    ? { provider: string(entry.provider) || "unknown", model: string(entry.modelId) || "unknown" }
    : previous;
}

/** Accept only actual finite nonnegative provider accounting values.
@param value - Untrusted numeric metadata.
@returns Recorded number, or null when absent or malformed.
*/
export function costNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reserve an attempt before provider dispatch so missing responses remain visible.
@param scope - Application-owned attribution.
@param id - Stable source or new attempt identity.
@param timestamp - Explicit accounting instant.
@returns Content-free pending observation.
*/
export function pendingCost(scope: CostScope, id: string, timestamp: string): CostObservation {
  return {
    ...scope,
    id,
    timestamp,
    status: "pending",
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    seconds: null,
    amountUSD: null,
    costKind: null,
    pricingSource: null,
  };
}

/** Project Decisions accounting; cache reads and writes are subsets of total input.
@param attempt - Original attempt attribution and accounting time.
@param response - Provider JSON, including usage even if semantic answers are invalid.
@param status - HTTP or transport outcome.
@returns Actual tokens and a dated standard-rate estimate when usage is available.
*/
export function decisionCost(attempt: CostObservation, response: unknown, status: CostObservation["status"]) {
  const usage = object(object(response).usage);
  const details = object(usage.input_tokens_details);
  const input = costNumber(usage.input_tokens);
  const cached = costNumber(details.cached_tokens) ?? 0;
  const written = costNumber(details.cache_write_tokens) ?? 0;
  const isValid = input !== null && cached + written <= input && attempt.model === "gpt-6-luna";
  const amount = isValid
    ? ((input - cached - written) * DECISION_INPUT_RATE +
        cached * DECISION_CACHE_RATE +
        written * DECISION_WRITE_RATE) /
      MILLION
    : null;

  return {
    ...attempt,
    status,
    inputTokens: input,
    cachedInputTokens: input === null ? null : cached,
    cacheWriteTokens: input === null ? null : written,
    outputTokens: costNumber(usage.output_tokens),
    amountUSD: amount,
    costKind: amount === null ? null : ("estimated" as const),
    pricingSource: amount === null ? null : DECISION_PRICING,
  };
}

/** Preserve failed and canceled provider-request accounting independently from task state.
@param reason - Native assistant stop reason.
@returns Accounting status for this source observation.
*/
function nativeCostStatus(reason: unknown): CostObservation["status"] {
  if (reason === "error") {
    return "failed";
  }

  return reason === "aborted" ? "aborted" : "complete";
}

/** Recover content-free native Pi accounting using immutable entry identities.
@param parentId - Owning Pocket conversation.
@param source - Native session entry; its prose never leaves this transformation.
@param identity - Explicit model selection for native summary records.
@returns One idempotent observation or null for non-assistant records.
*/
export function piCost(
  parentId: string,
  source: unknown,
  identity: PiCostModel = UNKNOWN_PI_MODEL
): CostObservation | null {
  const entry = object(source);
  const isContext = ["usage", "compaction", "branch_summary"].includes(string(entry.type));
  const message = isContext ? entry : object(entry.message);

  if ((!isContext && (entry.type !== "message" || message.role !== "assistant")) || !string(entry.id)) {
    return null;
  }

  const usage = object(message.usage);
  const input = costNumber(usage.input);
  const cached = costNumber(usage.cacheRead);
  const written = costNumber(usage.cacheWrite);
  const total = costNumber(object(usage.cost).total);
  const amount = total !== null && total > 0 ? total : null;
  const timestamp =
    typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : string(entry.timestamp);
  const pending = pendingCost(
    {
      parentId,
      feature: isContext ? "context" : "main",
      provider: string(message.provider) || identity.provider,
      model: string(message.model) || identity.model,
    },
    `pi:${parentId}:${string(entry.id)}`,
    timestamp
  );

  return {
    ...pending,
    status: nativeCostStatus(message.stopReason),
    inputTokens: input === null ? null : input + (cached ?? 0) + (written ?? 0),
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: costNumber(usage.output),
    amountUSD: amount,
    costKind: amount === null ? null : "estimated",
    pricingSource: amount === null ? null : CATALOG_PRICING,
  };
}

/** Estimate native delegate usage only from an exact matching model catalog entry.
@param modelId - Native model identity.
@param provider - Known native harness provider.
@param input - Uncached input tokens.
@param output - Output tokens, already including reasoning subsets.
@param cached - Cache-read input tokens.
@param written - Cache-write input tokens.
@returns API-equivalent estimate, or null for unknown models or incomplete counters.
*/
function delegateEstimate(
  modelId: string,
  provider: "openai" | "anthropic",
  input: number | null,
  output: number | null,
  cached: number,
  written: number
) {
  if (input === null || output === null) {
    return null;
  }

  const catalog = provider === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
  const models = z.array(modelPriceSchema).parse(Object.values(catalog));

  for (const model of models) {
    if (model.id === modelId) {
      return (
        (input * model.cost.input +
          output * model.cost.output +
          cached * model.cost.cacheRead +
          written * model.cost.cacheWrite) /
        MILLION
      );
    }
  }

  return null;
}

/** Normalize one native Claude request, replacing streaming revisions by message identity.
@param parentId - Managed command's parent.
@param sessionId - Owned native session.
@param source - Original SDK assistant event.
@param timestamp - Explicit receipt time, retained when a request is revised.
@returns Deduplicated native usage or null for non-assistant events.
*/
export function claudeCost(parentId: string, sessionId: string, source: unknown, timestamp: string) {
  const event = object(source);
  const message = object(event.message);

  if (event.type !== "assistant" || !string(message.id)) {
    return null;
  }

  const usage = object(message.usage);
  const input = costNumber(usage.input_tokens);
  const output = costNumber(usage.output_tokens);
  const cached = costNumber(usage.cache_read_input_tokens) ?? 0;
  const written = costNumber(usage.cache_creation_input_tokens) ?? 0;
  const model = string(message.model) || "unknown";
  const hourlyWrites = costNumber(object(usage.cache_creation).ephemeral_1h_input_tokens) ?? 0;
  const amount = hourlyWrites > 0 ? null : delegateEstimate(model, "anthropic", input, output, cached, written);
  const pending = pendingCost(
    { parentId, feature: "delegates", provider: "anthropic", model },
    `claude:${sessionId}:${string(message.id)}`,
    timestamp
  );

  return {
    ...pending,
    status: "complete" as const,
    inputTokens: input === null ? null : input + cached + written,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    amountUSD: amount,
    costKind: amount === null ? null : ("estimated" as const),
    pricingSource: amount === null ? null : CATALOG_PRICING,
  };
}

/** Normalize incremental Codex counters; stable cumulative identity prevents duplicate notifications.
@param parentId - Managed command's parent.
@param source - Actual native token-usage notification.
@param model - Owning adapter's current model identity.
@param timestamp - Explicit observation instant.
@returns Latest native request usage, or null for other notifications.
*/
export function codexCost(parentId: string, source: unknown, model: string, timestamp: string) {
  const event = object(source);
  const params = object(event.params);
  const usage = object(params.tokenUsage);
  const counts = object(usage.last);
  const totals = object(usage.total);

  if (
    event.method !== "thread/tokenUsage/updated" ||
    !string(params.threadId) ||
    Object.keys(object(usage.total)).length === 0 ||
    Object.keys(counts).length === 0
  ) {
    return null;
  }

  const input = costNumber(counts.inputTokens);
  const output = costNumber(counts.outputTokens);
  const cached = costNumber(counts.cachedInputTokens) ?? 0;
  const written = costNumber(counts.cacheWriteInputTokens) ?? 0;
  const amount = delegateEstimate(
    model,
    "openai",
    input === null || cached + written > input ? null : input - cached - written,
    output,
    cached,
    written
  );
  const identity = JSON.stringify([
    costNumber(totals.inputTokens),
    costNumber(totals.cachedInputTokens),
    costNumber(totals.cacheWriteInputTokens),
    costNumber(totals.outputTokens),
    costNumber(totals.reasoningOutputTokens),
    costNumber(totals.totalTokens),
  ]);
  const pending = pendingCost(
    { parentId, feature: "delegates", provider: "openai", model },
    `codex:${string(params.threadId)}:${string(params.turnId)}:${identity}`,
    timestamp
  );

  return {
    ...pending,
    status: "complete" as const,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    amountUSD: amount,
    costKind: amount === null ? null : ("estimated" as const),
    pricingSource: amount === null ? null : CATALOG_PRICING,
  };
}

/** Apply finalized per-second voice accounting once, separately from backend-agent usage.
@param attempt - Native voice session attribution.
@param event - Terminal provider event; reflected audio is never retained.
@returns Final duration and dated estimate, preserving unknown duration.
*/
export function voiceCost(attempt: CostObservation, event: unknown) {
  const seconds = costNumber(object(object(event).usage).seconds);
  const amount =
    seconds === null || attempt.model !== "gpt-live-1" ? null : (seconds * LIVE_MINUTE_RATE) / SECONDS_PER_MINUTE;

  return {
    ...attempt,
    status: "complete" as const,
    seconds,
    amountUSD: amount,
    costKind: amount === null ? null : ("estimated" as const),
    pricingSource: amount === null ? null : LIVE_PRICING,
  };
}
