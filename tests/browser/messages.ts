import type { Page } from "@playwright/test";

/**
Sends a test prompt through the actual composer in an explicitly enabled live workflow.
@param page - Browser already connected to the opted-in test session.
@param text - Exact test prompt entered into the parent composer.
@returns Completion of the composer fill and send gesture.
*/
export async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
