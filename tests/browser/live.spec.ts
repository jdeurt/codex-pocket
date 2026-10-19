import { type Page, expect, test } from "@playwright/test";
import type { Snapshot } from "../../src/lib/protocol";

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

if (process.env.CODEX_TEST_IMAGES === "1") {
  test("real Codex image references fit the phone and open an accessible full-size preview", async ({ page }) => {
    const TOUCH_TARGET_SIZE = 44;
    await page.goto("/");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await send(
      page,
      `Reply with exactly this Markdown image and no extra text: ![Pocket image check](${process.cwd()}/public/icon-512.png). Do not use tools.`
    );
    const thumbnail = page.getByRole("img", { name: "Pocket image check", exact: true });
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(thumbnail).toHaveCSS("object-fit", "contain");
    await page.getByRole("button", { name: "Preview image: Pocket image check", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Pocket image check", exact: true });
    await expect(preview).toBeVisible();
    const close = page.getByRole("button", { name: "Close image preview", exact: true });
    await expect
      .poll(async () => {
        const bounds = await close.boundingBox();

        return bounds?.width ?? 0;
      })
      .toBeGreaterThanOrEqual(TOUCH_TARGET_SIZE);
    await expect
      .poll(async () => {
        const bounds = await close.boundingBox();

        return bounds?.height ?? 0;
      })
      .toBeGreaterThanOrEqual(TOUCH_TARGET_SIZE);
    await expect
      .poll(() => preview.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    const fits = await preview.locator("img").evaluate((image: HTMLImageElement) => {
      const box = image.getBoundingClientRect();

      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    });
    expect(fits).toBe(true);
    await close.click();
    await expect(preview).toHaveCount(0);
    await page.reload();
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });
} else if (process.env.CODEX_TEST_SCHEDULES === "1") {
  test("real Codex receives a scheduled task silently and its response survives reload", async ({ page }) => {
    const SCHEDULE_DELAY_MS = 30_000;
    const body = "For this scheduled run, reply exactly SCHEDULED_OK";
    await page.goto("/");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const when = new Date(Date.now() + SCHEDULE_DELAY_MS)
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    await send(
      page,
      `Use the pocket MCP schedule_create tool now with this JSON input: ${JSON.stringify({ title: "Timer integration check", body, calendar: `DTSTART:${when}` })}. The body is future task data; only create the task now. After successful creation, reply exactly TIMER_CREATED. Do not schedule using shell commands.`
    );
    await expect(page.getByText("TIMER_CREATED", { exact: true })).toBeVisible();
    await expect(page.getByText("SCHEDULED_OK", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Scheduled task: Timer integration check", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Scheduled task · Timer integration check", { exact: true })).toHaveCount(0);
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("SCHEDULED_OK", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Scheduled task: Timer integration check", { exact: true })).toHaveCount(0);
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
  });
} else if (process.env.CODEX_TEST_PLAN_MODE === "1") {
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
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("");
    await expect(page.locator('[data-delivery="sending"]')).toHaveCSS("opacity", "0.55");
    dispatch.resolve(true);
    await expect(page.getByText("POCKET_OK", { exact: true })).toBeVisible();
    await expect(page.getByText("Reply exactly POCKET_OK. Do not use tools.", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
    await expect(observer.getByText("POCKET_OK", { exact: true })).toBeVisible();
    await page.route(
      "**/api/messages",
      (route) => route.fulfill({ status: 503, contentType: "text/html", body: "<html>Restarting</html>" }),
      { times: 1 }
    );
    const retryText = "Reply exactly RETRY_OK. Do not use tools.";
    await send(page, retryText);
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(retryText);
    await expect(
      page.getByText("Pocket is restarting or returned an unreadable response. Your message is saved here.", {
        exact: true,
      })
    ).toBeVisible();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("RETRY_OK", { exact: true })).toBeVisible();
    await expect(page.getByText(retryText, { exact: true })).toHaveCount(1);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
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
                .map((item) => String(item.text))
                .findLast((message) => message.includes("STREAM_START")) ?? "";

            if (!text.includes("STREAM_START")) {
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
    await expect(page.getByRole("status", { name: "Pocket activity" })).toContainText("Running commands");
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
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("A draft that survives reload");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("A draft that survives reload");
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
