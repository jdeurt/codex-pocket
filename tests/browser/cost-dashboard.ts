import { type Page, type TestInfo, expect } from "@playwright/test";

const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;

/** Read actual browser layout without treating chart/table scrolling as page overflow.
@returns Whether the page extends beyond the phone viewport.
*/
function hasPageOverflow() {
  const main = document.querySelector(".cost-page");

  return main !== null && main.scrollWidth > main.clientWidth;
}

/** Exercise the real Settings navigation, private accounting API and D3 projection.
@param context - Fixture browser with synthetic native accounting on disk.
@param info - Screenshot artifact owner.
*/
export async function costDashboardFlow({ page }: { page: Page }, info: TestInfo) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Usage & costs →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage & costs", exact: true })).toBeVisible();
  await expect(page.getByTestId("cost-total")).toHaveText("$2.05");
  await expect(page.getByText(/1 usage record has unknown costs/)).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await page.screenshot({ path: info.outputPath("usage-costs.png"), fullPage: true });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  const hasOverflow = await page.evaluate(hasPageOverflow);

  expect(hasOverflow).toBe(false);
  await expect(page.getByLabel("Model", { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Refresh usage", exact: true })).toBeInViewport();
  await page.locator(".cost-chart").scrollIntoViewIfNeeded();
  await expect(page.getByRole("img", { name: /Main agent: \$1.25/ })).toBeInViewport();
  await page.screenshot({ path: info.outputPath("usage-costs-mobile.png"), fullPage: true });
  await expect(page.getByRole("img", { name: /Main agent: \$1.25/ })).toBeVisible();
  await page.getByLabel("Group chart by", { exact: true }).selectOption("model");
  await expect(page.getByRole("img", { name: /fixture\/fixture-main: \$1.25/ })).toBeVisible();
  await page.getByLabel("Feature", { exact: true }).selectOption("task_intent");
  await expect(page.getByTestId("cost-total")).toHaveText("$0.000012");
  await page.getByLabel("Model", { exact: true }).selectOption("fixture/gpt-6-luna");
  await expect(page.getByTestId("cost-total")).toHaveText("$0.000012");
  await page.getByLabel("Time range", { exact: true }).selectOption("custom");
  await page.getByLabel("From", { exact: true }).fill("2000-01-01");
  await page.getByLabel("Through", { exact: true }).fill("2000-01-02");
  await expect(page.getByText("No recorded usage in this period. Try another time range or filter.")).toBeVisible();
  await page.getByLabel("Time range", { exact: true }).selectOption("7");
  await expect(page.getByTestId("cost-total")).toHaveText("$0.000012");
  await page.reload();
  await expect(page.getByTestId("cost-total")).toHaveText("$2.05");
  await page.getByText("How these costs are counted", { exact: true }).click();
  await expect(page.getByText(/This page tracks cost; it does not enforce a spending limit/)).toBeVisible();
  await page.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await expect(page.getByTestId("cost-total")).toHaveText("$2.05");
}
