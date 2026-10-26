import type { Dispatch, RefObject, SetStateAction } from "react";

const MIN_CHART_WIDTH = 260;

/** Publish actual plot width at the browser layout boundary.
@param publish - React-owned width setter.
@param entries - Native resize observations.
*/
function resizedCostChart(publish: Dispatch<SetStateAction<number>>, entries: ResizeObserverEntry[]) {
  const entry = entries.at(0);

  if (entry) {
    publish(Math.max(MIN_CHART_WIDTH, entry.contentRect.width));
  }
}

/** Keep D3 geometry sized to the viewport instead of hiding recent bars off-screen.
@param element - Mounted chart container.
@param publish - React-owned width setter.
@returns Resize subscription cleanup.
*/
export function watchCostChartWidth(
  element: RefObject<HTMLDivElement | null>,
  publish: Dispatch<SetStateAction<number>>
) {
  if (!element.current) {
    return;
  }

  const observer = new ResizeObserver(resizedCostChart.bind(undefined, publish));

  observer.observe(element.current);

  return observer.disconnect.bind(observer);
}
