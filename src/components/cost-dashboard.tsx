"use client";
import "./cost-dashboard.css";
import { useEffect, useReducer, useState, type ChangeEvent, type Dispatch } from "react";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { type CostGroup, type CostReport } from "@/lib/costs";
import { addedCostGroup, costFeatureLabel, costUSD, emptyCostGroup, costTimestamp, costRecords } from "@/state/costs";
import { costContributions, type CostDimension } from "@/state/cost-chart";
import { initialCostFilters, watchCostReport, type CostView } from "@/runtime/cost-report";
import { useBoundCallback, useDerivedValue } from "@/hooks/use-bound-callback";
import { CostFiltersPanel } from "./cost-filters";
import { CostChart } from "./cost-chart";

/** Select a chart grouping through a native control.
@param publish - React-owned grouping setter.
@param event - Feature/model selection.
*/
function changeDimension(publish: Dispatch<CostDimension>, event: ChangeEvent<HTMLSelectElement>) {
  publish(event.target.value === "model" ? "model" : "feature");
}

/** Increment the explicit refresh generation.
@param revision - Prior refresh generation.
@returns New generation.
*/
function refreshRevision(revision: number) {
  return revision + 1;
}

/** Show disjoint feature/model contributions, including unpriced requests.
@param group - Aggregated recorded contribution.
@returns Accessible cost and coverage table row.
*/
function contributionRow(group: CostGroup) {
  return (
    <tr key={`${group.feature}:${group.provider}:${group.model}`}>
      <th scope="row">
        {costFeatureLabel(group.feature)}
        <small>
          {group.provider}/{group.model}
        </small>
      </th>
      <td>{group.calls === group.unknownCosts ? "Unknown" : costUSD(group.estimatedUSD + group.reportedUSD)}</td>
      <td>{group.calls.toLocaleString()}</td>
      <td>{group.unknownCosts.toLocaleString()}</td>
    </tr>
  );
}

/** Render the saved pricing provenance without turning untrusted metadata into navigation.
@param source - Content-free pricing source retained at observation time.
@returns Audit detail.
*/
function pricingSource(source: string) {
  return <li key={source}>{source}</li>;
}

/** Present aggregate cost, evidence coverage and an auditable contribution table.
@param props - Current filtered report and grouping controls.
@returns Recorded totals, D3 chart and explicit estimate limitations.
*/
function CostResults({ report, dimension }: { report: CostReport; dimension: CostDimension }) {
  const contributions = useDerivedValue(costContributions, report.groups);
  const totals = report.groups.reduce(
    addedCostGroup.bind(undefined),
    emptyCostGroup("total", { feature: "main", model: "all", provider: "all" })
  );

  return (
    <>
      <section className="cost-summary" aria-label="Recorded cost summary">
        <p className="cost-total-label">Known cost {totals.unknownCosts > 0 && <span>· Partial total</span>}</p>
        <p className="cost-total" data-testid="cost-total">
          {costUSD(totals.estimatedUSD + totals.reportedUSD)}
        </p>
        <p>
          {costUSD(totals.estimatedUSD)} estimated ·{" "}
          {totals.reportedRecords > 0
            ? `${costUSD(totals.reportedUSD)} provider reported`
            : "Provider-reported cost unavailable"}
        </p>
        <p>
          {costRecords(totals.calls)} · {totals.inputTokens.toLocaleString()} input tokens (including{" "}
          {totals.cachedInputTokens.toLocaleString()} cached) · {totals.outputTokens.toLocaleString()} output tokens
          {totals.seconds > 0 && ` · ${totals.seconds.toLocaleString()} voice seconds`}
        </p>
        {totals.unknownCosts > 0 && (
          <p className="cost-coverage" role="status">
            {costRecords(totals.unknownCosts)} {totals.unknownCosts === 1 ? "has" : "have"} unknown costs, including{" "}
            {totals.pending.toLocaleString()} awaiting usage. They are excluded from dollars, not counted as free.
          </p>
        )}
        {totals.failed > 0 && (
          <p>
            {totals.failed.toLocaleString()} failed or aborted {totals.failed === 1 ? "attempt is" : "attempts are"}{" "}
            included when recorded.
          </p>
        )}
      </section>
      {report.groups.length > 0 ? (
        <>
          <CostChart report={report} dimension={dimension} />
          <section aria-labelledby="cost-contributors-heading">
            <h2 id="cost-contributors-heading">Contributions</h2>
            <div className="cost-table-scroll">
              <table>
                <caption className="sr-only">Cost and coverage by feature and model</caption>
                <thead>
                  <tr>
                    <th scope="col">Feature / model</th>
                    <th scope="col">Known USD</th>
                    <th scope="col">Records</th>
                    <th scope="col">Unknown cost</th>
                  </tr>
                </thead>
                <tbody>{contributions.map(contributionRow.bind(undefined))}</tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <p className="cost-empty">No recorded usage in this period. Try another time range or filter.</p>
      )}
      <details className="cost-notes">
        <summary>How these costs are counted</summary>
        <p>
          Costs cover all Pockets on this computer. One record represents a request, voice session, or native summary
          accounting entry. Tracking records model requests, task classifiers, managed Side Pockets, and finalized Live
          voice duration. Local routing and search do not make paid model calls.
        </p>
        <p>
          Estimates use recorded tokens or finalized voice seconds and the pricing source saved with each observation.
          They are API-equivalent estimates, not invoices or subscription consumption. Discounts, service tiers,
          long-context premiums, regional pricing and separately billed tools can change your bill.
        </p>
        <p>
          Historical usage is included only when native Pi records contain accounting and that Pocket is reopened. Older
          classifier, voice and delegate usage is not reconstructed. Calls without a final usage response remain
          unknown.
        </p>
        <p>
          This page tracks cost; it does not enforce a spending limit. Cached input and reasoning output are subsets,
          counted once. Voice backend work appears separately from voice duration.
        </p>
        {report.trackingSince && (
          <p>Earliest recorded usage: {costTimestamp(report.trackingSince, report.query.timezone)}.</p>
        )}
        <ul>{report.pricingSources.map(pricingSource.bind(undefined))}</ul>
      </details>
    </>
  );
}

/** Own report loading and controls at the browser lifecycle boundary.
@param props - Route-preserved return address for the selected conversation.
@returns Settings usage page with actual accounting, filters, refresh and recoverable errors.
*/
export function CostDashboard({ backHref }: { backHref: string }) {
  const [filters, setFilters] = useState(initialCostFilters);
  const [view, setView] = useState<CostView>({ loading: true });
  const [dimension, setDimension] = useState<CostDimension>("feature");
  const [refresh, refreshReport] = useReducer(refreshRevision, 0);
  const watch = useBoundCallback(watchCostReport, filters, setView);

  useEffect(watch, [watch, refresh]);

  return (
    <main className="cost-page">
      <div className="cost-page-inner">
        <a className="cost-back" href={backHref}>
          <ArrowLeftIcon aria-hidden="true" />
          Back to Pocket
        </a>
        <header className="cost-heading">
          <div>
            <p>Settings</p>
            <h1>Usage &amp; costs</h1>
          </div>
          <button type="button" onClick={refreshReport} disabled={view.loading} aria-label="Refresh usage">
            <RefreshCwIcon aria-hidden="true" />
            Refresh
          </button>
        </header>
        <CostFiltersPanel filters={filters} publish={setFilters} models={view.data?.models ?? []} />
        <div className="cost-grouping">
          <label htmlFor="cost-dimension">Group chart by</label>
          <select id="cost-dimension" value={dimension} onChange={changeDimension.bind(undefined, setDimension)}>
            <option value="feature">Feature</option>
            <option value="model">Model</option>
          </select>
        </div>
        {view.loading && <p role="status">Loading usage…</p>}
        {view.error && <p role="alert">{view.error}</p>}
        {view.data && (
          <>
            <CostResults report={view.data} dimension={dimension} />
            <p className="cost-updated">
              Updated {costTimestamp(view.data.generatedAt, view.data.query.timezone)}. Running calls may report usage
              later.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
