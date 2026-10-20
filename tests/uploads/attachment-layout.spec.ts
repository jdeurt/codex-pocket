import { type Item, initialSnapshot, object, snapshotSchema, string } from "../../src/lib/protocol";
import { type Locator, expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { type AgentEntry } from "../../src/lib/agents";
import assert from "node:assert/strict";
import { readSnapshot } from "../../scripts/read-snapshot.mjs";
import sharp from "sharp";

const GAP = 16;
const VERTICAL_PADDING = 8;
const BUBBLE_MAX_WIDTH = 0.8;
const directory = ".local/attachment-visual-review/corrected-verified";
const control = (action: string) =>
  writeFile(".local/uploads-replay/control.json", JSON.stringify({ id: crypto.randomUUID(), action }));

async function metrics(bubble: Locator) {
  return bubble.evaluate((element) => {
    const query = (selector: string, root: Element = element) => {
      const node = root.querySelector<HTMLElement>(selector);

      if (!node) {
        throw new Error(`Missing rendered element: ${selector}`);
      }

      return node;
    };
    const content = query('[data-slot="bubble-content"]');
    const parent = element.parentElement;

    if (!parent) {
      throw new Error("Message bubble has no parent.");
    }

    const group = query('[aria-label="Attachments"]', content);
    const rows = [...group.children].filter((row): row is HTMLElement => row instanceof HTMLElement);
    const text = content.querySelector<HTMLElement>(":scope > p");
    const first = rows[0].getBoundingClientRect();
    const icon = query("svg", rows[0]).getBoundingClientRect();
    const name = query("span", rows[0]).getBoundingClientRect();
    const style = getComputedStyle(content);

    return {
      itemGap: rows[1].getBoundingClientRect().top - first.bottom,
      textGap: text?.textContent ? text.getBoundingClientRect().top - group.getBoundingClientRect().bottom : null,
      iconInset: icon.left - first.left,
      iconTextGap: name.left - icon.right,
      widths: rows.map((row) => row.getBoundingClientRect().width),
      groupWidth: group.getBoundingClientRect().width,
      bubbleWidth: element.getBoundingClientRect().width,
      availableWidth: parent.getBoundingClientRect().width,
      nameTruncated: query("span[title]", rows[0]).scrollWidth > query("span[title]", rows[0]).clientWidth,
      // CSS dimensions carry units; coercion must parse their numeric prefix.
      contentWidth:
        content.clientWidth -
        Number(style.paddingLeft.replace(/px$/, "")) -
        Number(style.paddingRight.replace(/px$/, "")),
      margins: rows.map((row) => [getComputedStyle(row).marginTop, getComputedStyle(row).marginBottom]),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

test("real uploads fill the original bubble interior with static file rows and exact 16px gaps", async ({
  page,
}, info) => {
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#e38c39" } })
    .png()
    .toBuffer();

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Attach images or files", exact: true })).toBeEnabled();
  await control("complete");
  await expect(page.locator("header [role=status]")).toHaveText("Connected");
  const name = `${info.project.name}-a-long-image-filename-that-extends-beyond-the-desktop-text-area-and-must-truncate.png`;
  const document = `${info.project.name}-a-long-document-filename-for-overflow.xlsx`;

  await page.locator('input[type="file"]').setInputFiles([
    { name, mimeType: "image/png", buffer: png },
    {
      name: document,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("original file bytes"),
    },
  ]);
  const selected = page.getByRole("list", { name: "Selected attachments" });

  await expect(selected.getByText("Ready to send", { exact: true })).toHaveCount(2);
  await expect(selected.locator("img")).toHaveCount(0);
  const draft = await selected.evaluate((list) => {
    const rows = [...list.children].filter((row): row is HTMLElement => row instanceof HTMLElement);
    const card = rows[0];
    const style = getComputedStyle(card);
    const text = card.querySelector("p");
    const type = text?.nextElementSibling?.querySelector("span");
    const status = card.querySelector('[role="status"]');

    if (!text || !type || !status) {
      throw new Error("Draft card details are missing.");
    }

    return {
      left: style.paddingLeft,
      right: style.paddingRight,
      top: style.paddingTop,
      bottom: style.paddingBottom,
      gap: rows[1].getBoundingClientRect().left - card.getBoundingClientRect().right,
      aligned: [type, status].every((item) => item.getBoundingClientRect().left === text.getBoundingClientRect().left),
    };
  });

  expect(draft).toEqual({
    left: `${String(GAP)}px`,
    right: `${String(GAP)}px`,
    top: `${String(VERTICAL_PADDING)}px`,
    bottom: `${String(VERTICAL_PADDING)}px`,
    gap: GAP,
    aligned: true,
  });
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${info.project.name}-draft.png` });
  const message = `${info.project.name} text after the uploaded files`;

  await page.getByRole("textbox", { name: "Message Pocket" }).fill(message);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(selected).toHaveCount(0);
  const bubble = page.locator('[data-slot="bubble"][data-delivery="sent"]').filter({ hasText: message });
  const group = bubble.getByRole("list", { name: "Attachments", exact: true });

  await expect(group.getByRole("listitem")).toHaveCount(2);
  await expect(group.locator("img, a, button, [role=button], [download]")).toHaveCount(0);
  await expect(bubble.locator("img")).toHaveCount(0);
  await expect(bubble).toBeVisible();
  await expect
    .poll(() => metrics(bubble))
    .toMatchObject({ itemGap: GAP, textGap: GAP, iconInset: GAP, iconTextGap: GAP, overflow: false });
  const layout = await metrics(bubble);

  expect(layout.itemGap).toBe(GAP);
  expect(layout.textGap).toBe(GAP);
  expect(layout.iconInset).toBe(GAP);
  expect(layout.iconTextGap).toBe(GAP);
  expect(layout.groupWidth).toBeGreaterThan(0);
  expect(layout.bubbleWidth).toBeLessThanOrEqual(layout.availableWidth * BUBBLE_MAX_WIDTH + 1);
  expect(layout.nameTruncated).toBeTruthy();
  expect(layout.widths.every((width) => width === layout.groupWidth && width === layout.contentWidth)).toBeTruthy();
  expect(layout.margins).toEqual([
    ["0px", "0px"],
    ["0px", "0px"],
  ]);
  expect(layout.overflow).toBeFalsy();
  await writeFile(`${directory}/${info.project.name}-measurements.json`, JSON.stringify({ draft, layout }, null, 2));
  await page.screenshot({ path: `${directory}/${info.project.name}-sent.png` });

  // A newer/stale wire projection must not reintroduce a second uploaded-image preview.
  await control("duplicate-image");
  let projected: Item | undefined;

  await expect
    .poll(async () => {
      const response = await fetch(new URL("/api/events", page.url()));

      assert.ok(response.body);
      const state = snapshotSchema.parse(await readSnapshot(response.body));

      projected = state.turns
        .flatMap((turn) => turn.items)
        .find(
          (entry) =>
            entry.fixtureDuplicateImage &&
            Array.isArray(entry.content) &&
            entry.content.some((part: unknown) => string(object(part).text) === message)
        );

      return projected !== undefined;
    })
    .toBe(true);
  assert.ok(projected);

  expect(projected.images).toBeUndefined();
  await expect(bubble.locator("img, a, button")).toHaveCount(0);
  await control("complete");
  await expect(page.locator("header [role=status]")).toHaveText("Connected");

  // File-only messages keep the same bubble sizing, rather than stretching the parent.
  await page.locator('input[type="file"]').setInputFiles([
    { name: `file-only-${name}`, mimeType: "image/png", buffer: png },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
  ]);
  await expect(selected.getByText("Ready to send", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(selected).toHaveCount(0);
  const fileOnly = page.locator('[data-slot="bubble"][data-delivery="sent"]').filter({ hasText: `file-only-${name}` });

  await expect(fileOnly).toBeVisible();
  await expect
    .poll(() => metrics(fileOnly))
    .toMatchObject({ itemGap: GAP, textGap: null, iconInset: GAP, iconTextGap: GAP, overflow: false });
  const fileOnlyLayout = await metrics(fileOnly);

  expect(fileOnlyLayout.bubbleWidth).toBeLessThanOrEqual(fileOnlyLayout.availableWidth * BUBBLE_MAX_WIDTH + 1);
  expect(fileOnlyLayout.groupWidth).toBeGreaterThan(0);
  expect(
    fileOnlyLayout.widths.every((width) => width === fileOnlyLayout.groupWidth && width === fileOnlyLayout.contentWidth)
  ).toBeTruthy();
  expect(fileOnlyLayout.nameTruncated).toBeTruthy();
  await expect(fileOnly.locator("img, a, button, [role=button], [download]")).toHaveCount(0);
  await page.screenshot({ path: `${directory}/${info.project.name}-file-only.png` });
  await writeFile(
    `${directory}/${info.project.name}-file-only-measurements.json`,
    JSON.stringify(fileOnlyLayout, null, 2)
  );
  await control("complete");
});

test("read-only child cards stay noninteractive while unrelated assistant images retain their preview", async ({
  page,
}) => {
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#e38c39" } })
    .png()
    .toBuffer();
  const source = `data:image/png;base64,${png.toString("base64")}`;
  const agent: AgentEntry = {
    id: "attachment-reader",
    parentId: "upload-replay-parent",
    name: "Read-only files",
    source: "side-pocket",
    harness: "codex",
    status: "running",
    preview: "Saved attachments",
  };
  const files = [
    { id: crypto.randomUUID(), name: "saved-image.png", size: png.length, mediaType: "image/png", kind: "image" },
    { id: crypto.randomUUID(), name: "saved-file.txt", size: 7, mediaType: "text/plain", kind: "file" },
  ];

  await page.route("**/api/agents**", async (route) => {
    const child = new URL(route.request().url()).searchParams.has("agent");

    await route.fulfill({
      json: child
        ? {
            agent,
            history: "available",
            updatedAt: Date.now(),
            state: {
              ...initialSnapshot,
              connection: "connected",
              turns: [
                {
                  id: "child-turn",
                  status: "completed",
                  items: [
                    {
                      id: "child-files",
                      type: "userMessage",
                      attachments: files,
                      images: [{ source, alt: "Duplicate upload preview" }],
                      content: [{ type: "text", text: "Saved file message" }],
                    },
                    {
                      id: "assistant-image",
                      type: "imageOutput",
                      images: [{ source, alt: "Unrelated assistant image" }],
                    },
                  ],
                },
              ],
            },
          }
        : { agents: [agent], warnings: [], updatedAt: Date.now() },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "1 agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  await dialog.getByRole("button", { name: /Read-only files/ }).click();
  const group = dialog.getByRole("list", { name: "Attachments", exact: true });

  await expect(group.getByRole("listitem")).toHaveCount(2);
  await expect(group.locator("img, a, button")).toHaveCount(0);
  await expect(dialog.locator('input[type="file"], textarea, form')).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Attach|Upload|Send|Download|Retry|Remove/i })).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: "Duplicate upload preview" })).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: "Unrelated assistant image" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Preview image: Unrelated assistant image" })).toBeVisible();
});
