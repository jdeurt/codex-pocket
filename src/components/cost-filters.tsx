import { type Dispatch, type SetStateAction } from "react";
import { COST_FEATURES, type CostReport } from "@/lib/costs";
import { changeCostFilter, type CostFilters } from "@/runtime/cost-report";

/** Render one named recorded feature filter.
@param entry - Trusted feature identity and user-facing name.
@returns Native select option.
*/
function featureOption([key, label]: [string, string]) {
  return (
    <option key={key} value={key}>
      {label}
    </option>
  );
}

/** Render one qualified model filter without collapsing providers.
@param model - Actual observed provider/model identity.
@returns Native select option.
*/
function modelOption(model: string) {
  return (
    <option key={model} value={model}>
      {model}
    </option>
  );
}

/** Expose time, feature and model filters with native keyboard and mobile controls.
@param props - Current explicit form values, setter and observed model options.
@returns Labeled filter controls and optional inclusive local date range.
*/
export function CostFiltersPanel({
  filters,
  publish,
  models,
}: {
  filters: CostFilters;
  publish: Dispatch<SetStateAction<CostFilters>>;
  models: CostReport["models"];
}) {
  return (
    <div className="cost-filters">
      <div>
        <label htmlFor="cost-range">Time range</label>
        <select
          id="cost-range"
          value={filters.range}
          onChange={changeCostFilter.bind(undefined, publish, filters, "range")}
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="custom">Custom dates</option>
        </select>
      </div>
      <div>
        <label htmlFor="cost-feature">Feature</label>
        <select
          id="cost-feature"
          value={filters.feature}
          onChange={changeCostFilter.bind(undefined, publish, filters, "feature")}
        >
          <option value="">All features</option>
          {Object.entries(COST_FEATURES).map(featureOption.bind(undefined))}
        </select>
      </div>
      <div>
        <label htmlFor="cost-model">Model</label>
        <select
          id="cost-model"
          value={filters.model}
          onChange={changeCostFilter.bind(undefined, publish, filters, "model")}
        >
          <option value="">All models</option>
          {models.map(modelOption.bind(undefined))}
        </select>
      </div>
      {filters.range === "custom" && (
        <>
          <div>
            <label htmlFor="cost-from">From</label>
            <input
              id="cost-from"
              type="date"
              value={filters.from}
              onChange={changeCostFilter.bind(undefined, publish, filters, "from")}
            />
          </div>
          <div>
            <label htmlFor="cost-to">Through</label>
            <input
              id="cost-to"
              type="date"
              value={filters.to}
              onChange={changeCostFilter.bind(undefined, publish, filters, "to")}
            />
          </div>
        </>
      )}
    </div>
  );
}
