import { clipboardCalls, showChat } from "./copy-fixture";
import { expect, test } from "@playwright/test";

/**
Encodes arbitrary clipboard text as the renderer's explicit copy fence without normalizing its bytes.
@param text - Exact payload, including whitespace, Unicode and nested fence text.
@returns Markdown copy marker containing the JSON-encoded payload.
*/
const marker = (text: string) => "```pocket-copy\n" + JSON.stringify(text) + "\n```";

const EXPECTED_BLOCKS = 3;
const MAX_TABS = 8;

test("explicit assistant marker copies exact arbitrary text only on gesture and keeps one spaced block", async ({
  page,
  isMobile,
}, testInfo) => {
  const text =
    '  first\r\nsecond\n"quoted" \\ café 👋 e\u{0301} 雪\t\0\n<script>globalThis.copyExecuted=1</script>\n<img src=x onerror="globalThis.copyExecuted=1">\n```pocket-copy\n"nested"\n```\n  ';

  const { markdown, writes } = await showChat(page, `Before\n\n${marker(text)}\n\nAfter`);
  const button = markdown.getByRole("button", { name: "Copy text", exact: true });

  const geometry = await test.step("Verify gesture-only rendering before sampling copy-block spacing", async () => {
    await expect(button).toHaveCount(1);
    expect(await clipboardCalls(page)).toEqual([]);
    await expect(markdown.locator("script, img, a[href^='javascript:']")).toHaveCount(0);

    return await markdown.evaluate((element) => {
      const children = [...element.children];
      const [before, action, after] = children;

      return {
        count: children.length,
        gap: Number(getComputedStyle(element).getPropertyValue("--message-block-gap").replace("px", "")),
        before: action.getBoundingClientRect().top - before.getBoundingClientRect().bottom,
        after: after.getBoundingClientRect().top - action.getBoundingClientRect().bottom,
        marginBottom: getComputedStyle(action).marginBottom,
        tag: action.tagName,
      };
    });
  });

  expect(geometry.count).toBe(EXPECTED_BLOCKS);
  expect(geometry.tag).toBe("DIV");
  expect(geometry.marginBottom).toBe("0px");
  expect(geometry.before).toBeCloseTo(geometry.gap, 0);
  expect(geometry.after).toBeCloseTo(geometry.gap, 0);
  await page.screenshot({ path: testInfo.outputPath("copy-action.png"), fullPage: true });

  if (isMobile) {
    await button.tap();
  } else {
    for (let step = 0; step < MAX_TABS; step += 1) {
      await page.keyboard.press("Tab");

      if (await button.evaluate((element) => element === document.activeElement)) {
        break;
      }
    }

    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
  }

  await expect(markdown.getByRole("status")).toHaveText("Copied");
  await page.screenshot({ path: testInfo.outputPath("copy-action-copied.png"), fullPage: true });
  expect(await clipboardCalls(page)).toEqual([text]);
  expect(await page.evaluate(() => "copyExecuted" in globalThis)).toBe(false);
  expect(writes).toEqual([]);
});

test("streaming partial and malformed markers remain code until a valid closing fence arrives", async ({ page }) => {
  const { markdown, stream } = await showChat(page, '```pocket-copy\n"part');
  const button = markdown.getByRole("button", { name: "Copy text", exact: true });

  await expect(markdown.getByRole("button")).toHaveCount(0);
  await stream('```pocket-copy\n"complete JSON"');
  await expect(markdown).toContainText('"complete JSON"');
  await expect(markdown.getByRole("button")).toHaveCount(0);
  await stream('```pocket-copy\n"complete JSON"\n``');
  await expect(markdown).toContainText("``");
  await expect(markdown.getByRole("button")).toHaveCount(0);
  await stream(marker("complete JSON"));
  await expect(button).toBeVisible();
  expect(await clipboardCalls(page)).toEqual([]);
  await button.click();
  expect(await clipboardCalls(page)).toEqual(["complete JSON"]);
  await stream(marker("complete JSON") + "\n\nMore streamed text");
  await expect(markdown).toContainText("More streamed text");
  await expect(markdown.getByRole("status")).toHaveText("Copied");
  expect(await clipboardCalls(page)).toEqual(["complete JSON"]);
  await stream('```pocket-copy\n"bad JSON\n```');
  await expect(button).toHaveCount(0);
  await expect(markdown).toContainText('"bad JSON');
  await stream(marker("changed"));
  await expect(button).toBeVisible();
  await expect(markdown.getByRole("status")).toHaveText("");
});

for (const mode of ["reject", "unavailable"] as const) {
  test(`clipboard ${mode} reports an accessible error and never claims success`, async ({ page }, testInfo) => {
    const { markdown } = await showChat(page, marker("Denied text"), { clipboard: mode });

    await markdown.getByRole("button", { name: "Copy text", exact: true }).click();
    await expect(markdown.getByRole("status")).toHaveText(
      "Couldn’t copy. Check browser clipboard access and try again."
    );
    await expect(markdown.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await expect(markdown.getByRole("button")).toBeEnabled();
    await expect(markdown).not.toContainText("Copied");
    await page.screenshot({ path: testInfo.outputPath("copy-action-error.png"), fullPage: true });
    expect(await clipboardCalls(page)).toEqual(mode === "reject" ? ["Denied text"] : []);
  });
}

test("pending writes wait for completion and empty text remains a valid action", async ({ page }) => {
  const { markdown } = await showChat(page, marker(""), { clipboard: "pending" });
  const button = markdown.getByRole("button", { name: "Copy text", exact: true });

  await button.click();
  await expect(button).toBeDisabled();
  await expect(markdown.getByRole("status")).toHaveText("Copying…");
  expect(await clipboardCalls(page)).toEqual([""]);
  await page.evaluate(() => globalThis.window.copyTest.resolve?.());
  await expect(markdown.getByRole("status")).toHaveText("Copied");
  await expect(button).toBeEnabled();
});

test("native browser clipboard receives the decoded text", async ({ page, context, browserName }) => {
  const text = "Clipboard “quotes” 👋 雪\nSecond line\n";

  const { markdown, writes } =
    await test.step("Grant native clipboard access before mounting the real clipboard workflow", async () => {
      if (browserName === "chromium") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      }

      return await showChat(page, marker(text), { clipboard: "native" });
    });
  const isAvailable = await page.evaluate(() => "clipboard" in globalThis.navigator);

  test.skip(!isAvailable, "Native clipboard is unavailable in this browser environment.");
  await markdown.getByRole("button", { name: "Copy text", exact: true }).click();
  await expect(markdown.getByRole("status")).toHaveText("Copied");

  if (browserName === "chromium") {
    expect(await page.evaluate(() => globalThis.navigator.clipboard.readText())).toBe(text);
  } else {
    // WebKit requires a real paste gesture for clipboard read access.
    const composer = page.getByRole("textbox", { name: "Message Pocket" });

    await composer.fill("");
    await composer.press("ControlOrMeta+V");
    await expect(composer).toHaveValue(text);
  }

  expect(writes).toEqual([]);
});
