import { type Page, expect, test } from "@playwright/test";
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";

const marker = (text: string) => "```pocket-copy\n" + JSON.stringify(text) + "\n```";
const EXPECTED_BLOCKS = 3;
const MAX_TABS = 8;

declare global {
  interface Window {
    copyTest: { calls: string[]; resolve?: () => void };
  }
}

async function showChat(page: Page, text: string, items: Snapshot["turns"][number]["items"] = []) {
  const assistant = { id: "assistant-copy", type: "agentMessage", phase: "final_answer", text };
  const state: Snapshot = {
    ...structuredClone(initialSnapshot),
    connection: "connected",
    turns: [
      {
        id: "copy-flow",
        status: "completed",
        items: [...items, assistant],
      },
    ],
  };
  const writes: string[] = [];
  const markdown = page.locator('[data-message-id="assistant-copy"] .markdown');

  // Keep unrelated notification setup local and dismiss it before inspecting chat.
  await page.addInitScript(() => Reflect.deleteProperty(globalThis, "Notification"));
  await page.route("**/api/notifications", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(state)}\n\n`,
    })
  );
  await page.route("**/api/logs", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/messages", (route) => {
    writes.push(route.request().postData() ?? "");

    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss notification prompt", exact: true }).click();

  await expect(markdown).toBeVisible();

  return {
    markdown,
    writes,
    stream: async (next: string) => {
      state.turns[0].status = "inProgress";
      state.activeTurnId = "copy-flow";
      assistant.text = next;
      // Reconnect through the real event-stream hook with the next streamed snapshot.
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    },
  };
}

async function spyClipboard(page: Page, mode: "resolve" | "reject" | "pending" | "unavailable" = "resolve") {
  await page.addInitScript((behavior) => {
    const state: Window["copyTest"] = { calls: [] };

    globalThis.window.copyTest = state;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        behavior === "unavailable"
          ? undefined
          : {
              writeText(text: string) {
                state.calls.push(text);

                if (behavior === "reject") {
                  return Promise.reject(new DOMException("Clipboard denied", "NotAllowedError"));
                }

                if (behavior === "pending") {
                  return new Promise<void>((resolve) => {
                    state.resolve = resolve;
                  });
                }

                return Promise.resolve();
              },
            },
    });
  }, mode);
}

const clipboardCalls = (page: Page) => page.evaluate(() => globalThis.window.copyTest.calls);

test("explicit assistant marker copies exact arbitrary text only on gesture and keeps one spaced block", async ({
  page,
  isMobile,
}, testInfo) => {
  const text =
    '  first\r\nsecond\n"quoted" \\ café 👋 e\u{0301} 雪\t\0\n<script>globalThis.copyExecuted=1</script>\n<img src=x onerror="globalThis.copyExecuted=1">\n```pocket-copy\n"nested"\n```\n  ';

  await spyClipboard(page);
  const { markdown, writes } = await showChat(page, `Before\n\n${marker(text)}\n\nAfter`);
  const button = markdown.getByRole("button", { name: "Copy text", exact: true });

  await expect(button).toHaveCount(1);
  expect(await clipboardCalls(page)).toEqual([]);
  await expect(markdown.locator("script, img, a[href^='javascript:']")).toHaveCount(0);
  const geometry = await markdown.evaluate((element) => {
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

test("code examples, nested blocks, user text and tool output never become copy actions", async ({ page }) => {
  await spyClipboard(page);
  const example = marker("example");
  const samples = [
    `\`\`\`\`markdown\n${example}\n\`\`\`\``,
    `~~~text\n${example}\n~~~`,
    example
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    example
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
    "- example:\n" +
      example
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    '`pocket-copy "inline"`',
    '```pocket-copy extra\n"metadata"\n```',
    '~~~pocket-copy\n"wrong fence"\n~~~',
    '```pocket-copy\n{"text":"object"}\n```',
    '```pocket-copy\n"invalid \\q"\n```',
    "[Unsafe link](javascript:alert(1))",
  ].join("\n\n");
  const { markdown } = await showChat(page, samples, [
    { id: "user-marker", type: "userMessage", content: [{ type: "text", text: example }] },
    { id: "tool-marker", type: "commandExecution", content: [{ type: "text", text: example }] },
    { id: "image-marker", type: "imageOutput", content: [{ type: "text", text: example }] },
  ]);

  await expect(page.getByRole("button", { name: "Copy text", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-message-id="user-marker"]')).toContainText("pocket-copy");
  await expect(page.locator('[data-message-id="image-marker"]')).toContainText('"example"');
  await expect(markdown.locator("a[href^='javascript:']")).toHaveCount(0);
  expect(await clipboardCalls(page)).toEqual([]);
});

test("streaming partial and malformed markers remain code until a valid closing fence arrives", async ({ page }) => {
  await spyClipboard(page);
  const { markdown, stream } = await showChat(page, '```pocket-copy\n"part');

  await expect(markdown.getByRole("button")).toHaveCount(0);
  await stream('```pocket-copy\n"complete JSON"');
  await expect(markdown).toContainText('"complete JSON"');
  await expect(markdown.getByRole("button")).toHaveCount(0);
  await stream('```pocket-copy\n"complete JSON"\n``');
  await expect(markdown).toContainText("``");
  await expect(markdown.getByRole("button")).toHaveCount(0);
  await stream(marker("complete JSON"));
  const button = markdown.getByRole("button", { name: "Copy text", exact: true });

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

test("an empty streamed marker stays visible without empty flow blocks or extra wrapper space", async ({ page }) => {
  await spyClipboard(page);
  const { markdown, stream } = await showChat(page, "Before\n\n```pocket-copy");

  for (const partial of [
    "```",
    "```p",
    "```pocket-",
    "```pocket-copy",
    "```pocket-copy\n",
    "```pocket-copy\n \n",
    "```pocket-copy\n\n```",
    '```pocket-copy\n"unfinished',
  ]) {
    await stream("Before\n\n" + partial);
    await expect(markdown).toContainText(partial.trim());
    await expect(markdown.getByRole("button")).toHaveCount(0);
    expect(await markdown.evaluate((element) => [...element.children].every((child) => child.textContent.trim()))).toBe(
      true
    );
  }

  await stream(marker(""));
  const button = markdown.getByRole("button", { name: "Copy text", exact: true });

  await expect(button).toBeVisible();
  const dimensions = await button.evaluate((element) => {
    const buttonRect = element.getBoundingClientRect();
    const action = element.parentElement?.getBoundingClientRect();

    return action ? { width: action.width - buttonRect.width, height: action.height - buttonRect.height } : null;
  });

  expect(dimensions).toEqual({ width: 0, height: 0 });
});

for (const mode of ["reject", "unavailable"] as const) {
  test(`clipboard ${mode} reports an accessible error and never claims success`, async ({ page }, testInfo) => {
    await spyClipboard(page, mode);
    const { markdown } = await showChat(page, marker("Denied text"));

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
  await spyClipboard(page, "pending");
  const { markdown } = await showChat(page, marker(""));
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

  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }

  const { markdown, writes } = await showChat(page, marker(text));
  const isAvailable = await page.evaluate(() => "clipboard" in navigator);

  test.skip(!isAvailable, "Native clipboard is unavailable in this browser environment.");
  await markdown.getByRole("button", { name: "Copy text", exact: true }).click();
  await expect(markdown.getByRole("status")).toHaveText("Copied");

  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  } else {
    // WebKit requires a real paste gesture for clipboard read access.
    const composer = page.getByRole("textbox", { name: "Message Pocket" });

    await composer.fill("");
    await composer.press("Meta+V");
    await expect(composer).toHaveValue(text);
  }

  expect(writes).toEqual([]);
});
