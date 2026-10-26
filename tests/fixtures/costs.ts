import { pendingCost } from "../../src/state/cost-observations";
import { observeCost } from "../../src/server/cost-store";
import { DAY_MS } from "../../src/state/costs";
import type { CostFeature } from "../../src/lib/costs";

const MAIN_USD = 1.25;
const DELEGATE_USD = 0.75;
const CLASSIFIER_USD = 0.000012;
const VOICE_USD = 0.05;
const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 200;
const VOICE_SECONDS = 60;

/** Seed content-free synthetic accounting in an explicitly owned fixture directory.
@param directory - Browser fixture's private state root.
@param now - Explicit fixture timestamp.
*/
export function seedCostFixture(directory: string, now: number) {
  const entries: { feature: CostFeature; model: string; amount: number | null; age: number }[] = [
    { feature: "main", model: "fixture-main", amount: MAIN_USD, age: 0 },
    { feature: "delegates", model: "fixture-delegate", amount: DELEGATE_USD, age: 1 },
    { feature: "task_intent", model: "gpt-6-luna", amount: CLASSIFIER_USD, age: 0 },
    { feature: "voice", model: "gpt-live-1", amount: VOICE_USD, age: 0 },
    { feature: "task_lifecycle", model: "gpt-6-luna", amount: null, age: 0 },
  ];

  for (const [index, entry] of entries.entries()) {
    const pending = pendingCost(
      { parentId: "synthetic-parent", feature: entry.feature, provider: "fixture", model: entry.model },
      `cost-fixture:${String(index)}`,
      new Date(now - entry.age * DAY_MS).toISOString()
    );

    observeCost(
      {
        ...pending,
        status: entry.amount === null ? "aborted" : "complete",
        inputTokens: entry.feature === "voice" ? null : INPUT_TOKENS,
        outputTokens: entry.feature === "voice" ? null : OUTPUT_TOKENS,
        seconds: entry.feature === "voice" ? VOICE_SECONDS : null,
        amountUSD: entry.amount,
        costKind: entry.amount === null ? null : "estimated",
        pricingSource: entry.amount === null ? null : "Synthetic fixture rates; never production pricing",
      },
      directory
    );
  }
}
