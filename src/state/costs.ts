import { type CostGroup, type CostObservation, type CostQuery, COST_FEATURES } from "../lib/costs";

const CENT_USD = 0.01;
const SMALL_COST_PRECISION = 8;
export const DAY_MS = 86_400_000;
export const MAX_COST_DAYS = 366;

/** Validate an explicit half-open interval and its calendar timezone.
@param query - Parsed browser filters.
@returns Normalized ISO bounds, rejecting inverted or excessive ranges.
*/
export function validatedCostQuery(query: CostQuery) {
  const start = Date.parse(query.start);
  const end = Date.parse(query.end);

  if (end <= start || end - start > MAX_COST_DAYS * DAY_MS) {
    throw new Error("Choose a time range of up to 366 days, with the end after the start.");
  }

  new Intl.DateTimeFormat("en", { timeZone: query.timezone }).format(start);

  return { ...query, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** Select a stable calendar-day bucket in the viewer's explicit timezone.
@param timestamp - Recorded instant.
@param timezone - Validated IANA timezone.
@returns Sortable calendar date.
*/
export function costDay(timestamp: string, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

/** Create an empty aggregate with no invented usage or charges.
@param day - Explicit calendar bucket.
@param record - Recorded contribution identity.
@returns Zero-valued accumulator.
*/
export function emptyCostGroup(
  day: string,
  record: Pick<CostObservation, "feature" | "model" | "provider">
): CostGroup {
  return {
    day,
    ...record,
    calls: 0,
    unknownCosts: 0,
    pending: 0,
    failed: 0,
    estimatedUSD: 0,
    reportedUSD: 0,
    reportedRecords: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    seconds: 0,
  };
}

/** Sum disjoint accounting categories, preserving partial coverage.
@param left - Existing aggregate.
@param right - Next independent aggregate.
@returns New total without mutating either contribution.
*/
export function addedCostGroup(left: CostGroup, right: CostGroup): CostGroup {
  return {
    ...left,
    calls: left.calls + right.calls,
    unknownCosts: left.unknownCosts + right.unknownCosts,
    pending: left.pending + right.pending,
    failed: left.failed + right.failed,
    estimatedUSD: left.estimatedUSD + right.estimatedUSD,
    reportedUSD: left.reportedUSD + right.reportedUSD,
    reportedRecords: left.reportedRecords + right.reportedRecords,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    seconds: left.seconds + right.seconds,
  };
}

/** Format small classifier charges without rounding them down to zero.
@param amount - Known USD amount.
@returns Currency label with enough precision for inexpensive requests.
*/
export function costUSD(amount: number) {
  const precision = amount > 0 && amount < CENT_USD ? SMALL_COST_PRECISION : 2;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: precision,
  }).format(amount);
}

/** Name a recorded feature in user-facing terms.
@param feature - Trusted feature identity.
@returns Settings label.
*/
export function costFeatureLabel(feature: CostGroup["feature"]) {
  return COST_FEATURES[feature];
}

/** Format a recorded instant in the explicitly selected report timezone.
@param timestamp - Actual accounting instant.
@param timezone - Validated IANA timezone.
@returns Local human-readable date and time.
*/
export function costTimestamp(timestamp: string, timezone: string) {
  return new Intl.DateTimeFormat("en", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp)
  );
}

/** Name observed accounting records without implying a completed task or billed request.
@param count - Actual record count.
@returns Singular or plural usage label.
*/
export function costRecords(count: number) {
  return `${count.toLocaleString("en-US")} usage ${count === 1 ? "record" : "records"}`;
}
