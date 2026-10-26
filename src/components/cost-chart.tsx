import { type CostReport } from "@/lib/costs";
import { costChart, COST_CHART_WIDTH, type CostDimension } from "@/state/cost-chart";
import { useBoundCallback, useDerivedValue } from "@/hooks/use-bound-callback";
import { useEffect, useRef, useState } from "react";
import { watchCostChartWidth } from "@/runtime/cost-chart";

const TICK_OFFSET = 8;
const DATE_OFFSET = 12;

type Chart = ReturnType<typeof costChart>;

/** Render one independently labeled stacked contribution.
@param bar - D3-computed geometry and exact amount label.
@returns Focusable SVG contribution with native hover detail.
*/
function costBar(bar: Chart["bars"][number]) {
  return bar.amount > 0 ? (
    <rect
      key={bar.key}
      x={bar.x}
      y={bar.y}
      width={bar.width}
      height={bar.height}
      fill={bar.color}
      tabIndex={0}
      role="img"
      aria-label={bar.label}
    >
      <title>{bar.label}</title>
    </rect>
  ) : null;
}

/** Render an exact dollar-axis guide.
@param chart - Plot bounds.
@param tick - D3-selected scale tick.
@returns Subdued guide with readable currency label.
*/
function costTick(chart: Chart, tick: Chart["ticks"][number]) {
  return (
    <g key={tick.value} className="cost-axis" aria-hidden="true">
      <line x1={chart.left} x2={chart.right} y1={tick.y} y2={tick.y} />
      <text x={chart.left - TICK_OFFSET} y={tick.y} dy="0.35em" textAnchor="end">
        {tick.label}
      </text>
    </g>
  );
}

/** Render one calendar-date label.
@param height - Explicit view-box height.
@param label - Selected readable date and position.
@returns Horizontal axis label.
*/
function costDate(height: number, label: Chart["labels"][number]) {
  return (
    <text
      key={label.day}
      x={label.x}
      y={height - DATE_OFFSET}
      textAnchor="middle"
      className="cost-axis"
      aria-hidden="true"
    >
      {label.label}
    </text>
  );
}

/** Pair chart colors with text so a contribution is never identified by color alone.
@param item - Named D3 series.
@returns Readable legend entry.
*/
function costLegend(item: Chart["legend"][number]) {
  return (
    <li key={item.key}>
      <span style={{ backgroundColor: item.color }} aria-hidden="true" />
      {item.name}
    </li>
  );
}

/** Present D3-computed daily costs with keyboard detail and an equivalent contribution table below.
@param props - Actual filtered report and chosen breakdown.
@returns Responsive, scrollable stacked bar chart.
*/
export function CostChart({ report, dimension }: { report: CostReport; dimension: CostDimension }) {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(COST_CHART_WIDTH);
  const watch = useBoundCallback(watchCostChartWidth, element, setWidth);
  const chart = useDerivedValue(costChart, report, dimension, width);

  useEffect(watch, [watch]);

  return (
    <figure className="cost-chart">
      <div className="cost-chart-scroll" ref={element}>
        <svg
          viewBox={`0 0 ${String(chart.width)} ${String(chart.height)}`}
          aria-labelledby="cost-chart-title cost-chart-description"
        >
          <title id="cost-chart-title">Daily recorded cost by {dimension}</title>
          <desc id="cost-chart-description">
            Stacked daily contributions in USD. Requests with unknown costs are excluded from bar heights. Focus a bar
            for its amount, or read the contributions table below.
          </desc>
          {chart.ticks.map(costTick.bind(undefined, chart))}
          {chart.bars.map(costBar.bind(undefined))}
          {chart.labels.map(costDate.bind(undefined, chart.height))}
        </svg>
      </div>
      <figcaption>Daily totals · {report.query.timezone} · USD</figcaption>
      <ul className="cost-legend" aria-label="Chart legend">
        {chart.legend.map(costLegend.bind(undefined))}
      </ul>
    </figure>
  );
}
