import type { Page } from "@playwright/test";

export async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
