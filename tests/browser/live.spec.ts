import { type Page, expect, test } from "@playwright/test";
import type { Snapshot } from "../../src/lib/protocol";

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
    const observer = await page.context().newPage();
    await observer.goto("/");
    await expect(observer.getByText("Connected", { exact: true })).toBeVisible();
    const dispatch = Promise.withResolvers<boolean>();
    await page.route(
      "**/api/messages",
      async (route) => {
        await dispatch.promise;
        await route.continue();
      },
      { times: 1 }
    );
    await send(page, "Reply exactly POCKET_OK. Do not use tools.");
    await expect(page.getByText("Sending…", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("");
    await expect(page.locator('[data-delivery="sending"]')).toHaveCSS("opacity", "0.55");
    dispatch.resolve(true);
    await expect(page.getByText("POCKET_OK", { exact: true })).toBeVisible();
    await expect(page.getByText("Reply exactly POCKET_OK. Do not use tools.", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
    await expect(observer.getByText("POCKET_OK", { exact: true })).toBeVisible();
    const streaming = observer.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const STREAM_TIMEOUT_MS = 90_000;
          const source = new EventSource("/api/events");
          const prefixes = new Set<string>();
          const timer = setTimeout(() => {
            source.close();
            reject(new Error("Live response streaming timed out."));
          }, STREAM_TIMEOUT_MS);
          source.addEventListener("message", (event: MessageEvent<string>) => {
            const LAST_TURN_INDEX = -1;
            const state = JSON.parse(event.data) as Snapshot;
            const text =
              state.turns
                .at(LAST_TURN_INDEX)
                ?.items.filter((item) => item.type === "agentMessage")
                .map((item) => item.text)
                .join("") ?? "";

            if (!text.startsWith("STREAM_START")) {
              return;
            }

            if (state.activeTurnId) {
              prefixes.add(text);
            }

            if (!text.includes("STREAM_END") || state.activeTurnId) {
              return;
            }

            clearTimeout(timer);
            source.close();
            resolve(prefixes.size);
          });
        })
    );
    await send(
      page,
      "Start with STREAM_START, list the numbers 1 through 120 one per line, and finish with STREAM_END. Do not use tools."
    );
    expect(await streaming).toBeGreaterThan(1);
    await expect(observer.getByText(/STREAM_START[\s\S]*STREAM_END/).last()).toBeVisible();
    await observer.close();
    await send(page, "Run the read-only shell command sleep 5, then reply BEFORE_STEER. Do not change any files.");
    await expect(page.getByRole("status", { name: "Thinking" })).toBeVisible();
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
