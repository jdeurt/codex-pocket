import { max } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import { stack } from "d3-shape";
import { type CostGroup, type CostReport, COST_FEATURES, costFeatureSchema } from "../lib/costs";
import { addedCostGroup, costDay, costUSD, DAY_MS } from "./costs";

export type CostDimension = "feature" | "model";
interface ChartDay {
  day: string;
  values: Record<string, number>;
}
export const COST_CHART_WIDTH = 760;
const HEIGHT = 280;
const LEFT = 70;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 40;
const BAR_PADDING = 0.2;
const TICK_COUNT = 4;
const LABEL_COUNT = 6;
const MOBILE_LABEL_COUNT = 4;
const MOBILE_BREAKPOINT = 500;
export const COST_COLORS = ["#88b5fa", "#bda4ed", "#75c9b6", "#edb474", "#e98fa6", "#b3c777"];

/** Identify a contribution without merging the same model name across providers.
@param group - One daily aggregate.
@param dimension - User-selected chart breakdown.
@returns Stable series identity.
*/
function seriesKey(group: CostGroup, dimension: CostDimension) {
  return dimension === "feature" ? group.feature : `${group.provider}/${group.model}`;
}

/** Read a D3 stack value from an explicit daily bucket.
@param day - Zero-filled daily values.
@param key - Series identity.
@returns Known dollars; missing-cost requests are represented separately by coverage counts.
*/
function stackValue(day: ChartDay, key: string) {
  return day.values[key] ?? 0;
}

/** Describe a chart series in accessible interface language.
@param key - Trusted feature or qualified model identity.
@param dimension - Selected chart breakdown.
@returns Legend text.
*/
export function costSeriesLabel(key: string, dimension: CostDimension) {
  const feature = costFeatureSchema.safeParse(key);

  return dimension === "feature" && feature.success ? COST_FEATURES[feature.data] : key;
}

/** Order stable series identities without depending on insertion order.
@param left - First label.
@param right - Second label.
@returns Deterministic lexical order.
*/
function compareCostNames(left: string, right: string) {
  return left.localeCompare(right);
}

/** Build daily stacked bars with D3, preserving zero days and explicit accounting gaps.
@param report - Validated filtered aggregates and interval.
@param dimension - Feature or model series grouping.
@param width - Actual plot width supplied by the browser layout boundary.
@returns Pure SVG geometry and accessible labels.
*/
export function costChart(report: CostReport, dimension: CostDimension, width = COST_CHART_WIDTH) {
  const keys = new Set<string>();
  const days = new Map<string, ChartDay>();
  const first = costDay(report.query.start, report.query.timezone);
  const last = costDay(new Date(Date.parse(report.query.end) - 1).toISOString(), report.query.timezone);

  for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, "YYYY-MM-DD".length);

    days.set(day, { day, values: {} });
  }

  for (const group of report.groups) {
    const key = seriesKey(group, dimension);
    const day = days.get(group.day);

    keys.add(key);

    if (day) {
      day.values[key] = (day.values[key] ?? 0) + group.estimatedUSD + group.reportedUSD;
    }
  }

  const series = keys.values().toArray().toSorted(compareCostNames);
  const buckets = days.values().toArray();
  const domain = days.keys().toArray();
  const x = scaleBand()
    .domain(domain)
    .range([LEFT, width - RIGHT])
    .padding(BAR_PADDING);
  const stacked = stack<ChartDay>().keys(series).value(stackValue)(buckets);
  const peaks: number[] = [];

  for (const layer of stacked) {
    for (const point of layer) {
      peaks.push(point[1]);
    }
  }

  const maximum = max(peaks) ?? 0;
  const y = scaleLinear()
    .domain([0, maximum > 0 ? maximum : 1])
    .nice()
    .range([HEIGHT - BOTTOM, TOP]);
  const bars = [];
  const legend = [];

  for (const [index, layer] of stacked.entries()) {
    const color = COST_COLORS[index % COST_COLORS.length];
    const name = costSeriesLabel(layer.key, dimension);

    legend.push({ key: layer.key, name, color });

    for (const point of layer) {
      const amount = point[1] - point[0];

      bars.push({
        key: `${point.data.day}:${layer.key}`,
        day: point.data.day,
        name,
        amount,
        color,
        x: x(point.data.day) ?? LEFT,
        y: y(point[1]),
        width: x.bandwidth(),
        height: y(point[0]) - y(point[1]),
        label: `${point.data.day}, ${name}: ${costUSD(amount)}`,
      });
    }
  }

  const labels = [];
  const labelCount = width < MOBILE_BREAKPOINT ? MOBILE_LABEL_COUNT : LABEL_COUNT;
  const stride = Math.max(1, Math.ceil(domain.length / labelCount));

  for (const [index, day] of domain.entries()) {
    if (index % stride === 0) {
      labels.push({ day, label: day.slice("YYYY-".length), x: (x(day) ?? LEFT) + x.bandwidth() / 2 });
    }
  }

  const ticks = Array.from(y.ticks(TICK_COUNT), (value) => ({ value, label: costUSD(value), y: y(value) }));

  return { width, height: HEIGHT, left: LEFT, right: width - RIGHT, bars, labels, ticks, legend };
}

/** Order contributions by known charge, retaining a deterministic tie break.
@param left - First contribution.
@param right - Second contribution.
@returns Descending dollar order.
*/
function compareContributions(left: CostGroup, right: CostGroup) {
  return (
    right.estimatedUSD + right.reportedUSD - left.estimatedUSD - left.reportedUSD ||
    `${left.feature}:${left.model}`.localeCompare(`${right.feature}:${right.model}`)
  );
}

/** Roll up days into feature/model contributions for the accessible table.
@param groups - Filtered disjoint daily contributions.
@returns Contributions ordered by known dollars, highest first.
*/
export function costContributions(groups: CostGroup[]) {
  const result = new Map<string, CostGroup>();

  for (const group of groups) {
    const key = `${group.feature}:${group.provider}:${group.model}`;
    const previous = result.get(key);

    result.set(key, previous ? addedCostGroup(previous, group) : group);
  }

  return result.values().toArray().toSorted(compareContributions);
}
