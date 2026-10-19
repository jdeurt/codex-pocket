import { type Page, expect, test } from "@playwright/test";

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message Codex" }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

if (process.env.CODEX_TEST_PLAN_MODE === "1") {
  test("real Codex questions show options and accept an answer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await send(
      page,
      "Use the request_user_input tool now to ask which label I prefer, with options Alpha and Beta. Do not just ask in plain text. After I choose, reply exactly QUESTION_OK."
    );
    await expect(page.getByText("A question for you", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Alpha/ }).click();
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect(page.getByText("QUESTION_OK", { exact: true })).toBeVisible();
  });
} else {
  test("real Codex streams, accepts follow-ups, resumes history and handles approvals on a phone", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pocket", exact: true })).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Model and reasoning effort")).toContainText("reasoning");
    await send(page, "Reply exactly POCKET_OK. Do not use tools.");
    await expect(page.getByText("POCKET_OK", { exact: true })).toBeVisible();
    await send(page, "Run the read-only shell command sleep 5, then reply BEFORE_STEER. Do not change any files.");
    await expect(page.getByText("Thinking", { exact: true })).toBeVisible();
    await send(page, "Steering update: reply exactly STEER_OK instead.");

    if (process.env.CODEX_TEST_ACTIVE_MODE === "queue") {
      await expect(page.getByText("Queued", { exact: true })).toBeVisible();
      await expect(page.getByText("BEFORE_STEER", { exact: true })).toBeVisible();
    }

    await expect(page.getByText("STEER_OK", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("STEER_OK", { exact: true })).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await send(
      page,
      "Approval check: run mkdir -p approval-probe in the current test directory using exec_command with sandbox_permissions=require_escalated and justification 'May I create the test folder?'. Ask for approval first. After success reply exactly APPROVAL_OK."
    );
    await expect(page.getByText("Approval needed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    await expect(page.getByText("APPROVAL_OK", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message Codex" }).fill("A draft that survives reload");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("A draft that survives reload");
    const centerDifference = await page.locator(".composer").evaluate((composer) => {
      const input = composer.querySelector("textarea");
      const button = composer.querySelector("button[type=submit]");

      if (!input || !button) {
        throw new Error("Composer controls are missing.");
      }

      const style = getComputedStyle(input);
      const textCenter =
        input.getBoundingClientRect().top +
        Number(style.paddingTop.replace("px", "")) +
        Number(style.lineHeight.replace("px", "")) / 2;
      const buttonBounds = button.getBoundingClientRect();

      return Math.abs(textCenter - (buttonBounds.top + buttonBounds.height / 2));
    });
    expect(centerDifference).toBeLessThanOrEqual(1);
    await page.screenshot({ path: ".local/live-check-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  });
}
