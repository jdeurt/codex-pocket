import { type UsageRecord } from "./usage-records";
import { z } from "zod";

const PER_MILLION = 1_000_000;
const CATEGORIES = [
  "uncached_input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;
const ratesSchema = z.record(z.enum(CATEGORIES), z.number().nonnegative().optional());
const priceSchema = z.object({
  harness: z.enum(["codex", "claude"]),
  model: z.string(),
  currency: z.string(),
  source: z.string(),
  date: z.iso.date(),
  serviceTier: z.string().nullable(),
  perMillion: ratesSchema,
});
export const usagePricesSchema = z.array(priceSchema);

export type UsagePrice = z.infer<typeof usagePricesSchema>[number];

/**
Normalize billable categories without adding cache-input or reasoning-output subsets twice.
@param record - Native usage observation with original provider categories retained separately.
@returns Distinct billable token categories used only for explicit price estimates.
*/
function billableTokens(record: UsageRecord) {
  const counts = new Map(Object.entries(record.categories));

  return record.harness === "codex"
    ? {
        uncached_input_tokens: Math.max(
          0,
          (counts.get("input_tokens") ?? 0) - (counts.get("cached_input_tokens") ?? 0)
        ),
        cached_input_tokens: counts.get("cached_input_tokens") ?? 0,
        cache_creation_input_tokens: 0,
        output_tokens: counts.get("output_tokens") ?? 0,
      }
    : {
        uncached_input_tokens: counts.get("input_tokens") ?? 0,
        cached_input_tokens: counts.get("cache_read_input_tokens") ?? 0,
        cache_creation_input_tokens: counts.get("cache_creation_input_tokens") ?? 0,
        output_tokens: counts.get("output_tokens") ?? 0,
      };
}

/**
Sum distinct billable categories only when every used category has a supplied rate.
@param records - Usage for the selected provider and model.
@param price - Dated user-selected price record.
@returns Explicit token-price estimate with its currency and service tier.
*/
function estimatePriced(records: UsageRecord[], price: UsagePrice) {
  let amount = 0;

  for (const record of records) {
    const counts = billableTokens(record);

    for (const category of CATEGORIES) {
      const rate = price.perMillion[category];

      if (rate === undefined && counts[category] > 0) {
        return null;
      }

      amount += counts[category] * (rate ?? 0);
    }
  }

  return {
    kind: "token-price estimate",
    amount: amount / PER_MILLION,
    currency: price.currency,
    source: price.source,
    date: price.date,
    serviceTier: price.serviceTier,
  };
}

/**
Estimate tokens only from an explicit caller-supplied dated price source; never imply a billed charge.
@param records - One chat/model group's deduplicated usage.
@param prices - Explicit pricing records supplied with the report command.
@returns Estimate and provenance, or null for incomplete pricing/usage coverage.
*/
export function estimatedCost(records: UsageRecord[], prices: UsagePrice[]) {
  const record = records.at(0);

  for (const price of prices) {
    if (price.harness === record?.harness && price.model === record.model) {
      return estimatePriced(records, price);
    }
  }

  return null;
}
