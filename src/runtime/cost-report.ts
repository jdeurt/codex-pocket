import { type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { t } from "try";
import { type CostReport, costReportSchema, type CostFeature } from "../lib/costs";
import { DAY_MS, validatedCostQuery } from "../state/costs";

export interface CostFilters {
  range: string;
  from: string;
  to: string;
  feature: CostFeature | "";
  model: string;
}
export interface CostView {
  data?: CostReport;
  loading: boolean;
  error?: string;
}
const DEFAULT_DAYS = 7;
const MINUTE_MS = 60_000;

/** Initialize local calendar controls at the browser lifecycle boundary.
@returns Default last-week interval with editable calendar dates.
*/
export function initialCostFilters(): CostFilters {
  const now = new Date();
  const to = new Date(now.getTime() - now.getTimezoneOffset() * MINUTE_MS).toISOString().slice(0, "YYYY-MM-DD".length);
  const from = new Date(Date.parse(to) - (DEFAULT_DAYS - 1) * DAY_MS).toISOString().slice(0, "YYYY-MM-DD".length);

  return { range: String(DEFAULT_DAYS), from, to, feature: "", model: "" };
}

/** Publish a native control selection without capturing stale form state.
@param publish - React-owned form setter.
@param filters - Explicit currently rendered values.
@param field - Changed filter.
@param event - Native input or select event.
*/
export function changeCostFilter(
  publish: Dispatch<SetStateAction<CostFilters>>,
  filters: CostFilters,
  field: keyof CostFilters,
  event: ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  publish({ ...filters, [field]: event.target.value });
}

/** Resolve browser-local calendar bounds to exact instants, including DST days.
@param filters - Explicit form selection.
@returns Encoded guarded API query; end is exclusive.
*/
function costQueryURL(filters: CostFilters) {
  const now = new Date();
  const start =
    filters.range === "custom"
      ? new Date(`${filters.from}T00:00:00`)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(filters.range) + 1);
  const end = filters.range === "custom" ? new Date(`${filters.to}T00:00:00`) : now;

  if (filters.range === "custom") {
    end.setDate(end.getDate() + 1);
  }

  const query = validatedCostQuery({
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const params = new URLSearchParams(query);

  if (filters.feature) {
    params.set("feature", filters.feature);
  }

  if (filters.model) {
    params.set("model", filters.model);
  }

  return `/api/costs?${params.toString()}`;
}

/** Fetch real accounting without allowing stale filter responses to replace the selected report.
@param filters - Current browser controls.
@param publish - React-owned view setter.
@param signal - Unmount, refresh or filter-change cancellation.
*/
async function loadCostReport(filters: CostFilters, publish: Dispatch<SetStateAction<CostView>>, signal: AbortSignal) {
  publish({ loading: true });
  const url = t(costQueryURL, filters);
  const fetched = url.ok ? await t(fetch, url.value, { signal, cache: "no-store" }) : url;
  const decoded = fetched.ok ? await t(fetched.value.json.bind(fetched.value)) : fetched;

  if (signal.aborted) {
    return;
  }

  const parsed = decoded.ok ? costReportSchema.safeParse(decoded.value) : undefined;

  if (!fetched.ok || !fetched.value.ok || !parsed?.success) {
    publish({
      loading: false,
      error: "Could not load costs. Choose a valid time range of up to 366 days, then retry.",
    });

    return;
  }

  publish({ loading: false, data: parsed.data });
}

/** Own one cancellable report request for the mounted dashboard.
@param filters - Current interval and contribution selection.
@param publish - React-owned view setter.
@returns Cleanup which prevents stale results after navigation or a newer selection.
*/
export function watchCostReport(filters: CostFilters, publish: Dispatch<SetStateAction<CostView>>) {
  const controller = new AbortController();

  void loadCostReport(filters, publish, controller.signal);

  return controller.abort.bind(controller);
}
