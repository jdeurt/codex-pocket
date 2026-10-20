import { type Page, expect, test } from "@playwright/test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { initialSnapshot } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";
import path from "node:path";

const directory = path.resolve(".local/viewer-native-tests");
const EDGE = 8;
const SHORT_DRAG = 40;
const VERTICAL_DRAG = 80;
const SWIPE_DIVISOR = 2;
const HALF = 2;

/**
Exercise real pointer movement at the document edge without replacing native scrolling.
@param page - Browser with an open local document.
@param horizontal - Horizontal pointer displacement.
@param vertical - Vertical displacement used to distinguish scrolling from navigation.
*/
async function dragEdge(page: Page, horizontal: number, vertical = 0) {
  const middle = await page.locator(".file-viewer").evaluate((element) => element.clientHeight / 2);

  await page.mouse.move(EDGE, middle);
  await page.mouse.down();
  await page.mouse.move(EDGE + horizontal, middle + vertical, { steps: HALF });
  await page.mouse.up();
}

test("native files retain browser MIME behavior and deliberate edge swipes preserve the parent", async ({
  page,
  request,
}, info) => {
  const writes = await test.step("Create local native fixtures and open their chat links", async () => {
    await mkdir(directory, { recursive: true });
    await copyFile("public/icon-192.png", path.join(directory, "image.png"));
    await writeFile(
      path.join(directory, "document.pdf"),
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
    );
    await writeFile(path.join(directory, "archive.bin"), "native download");

    return mount(page, {
      ...initialSnapshot,
      connection: "connected",
      turns: [
        {
          id: "files",
          status: "completed",
          items: [
            {
              id: "links",
              type: "agentMessage",
              text: `[Image](<${directory}/image.png>) [PDF](<${directory}/document.pdf>) [Other](<${directory}/archive.bin>)`,
            },
          ],
        },
      ],
    });
  });
  const image = await request.get(`/api/files?path=${encodeURIComponent(path.join(directory, "image.png"))}`);
  const pdf = await request.get(`/api/files?path=${encodeURIComponent(path.join(directory, "document.pdf"))}`);
  const denied = await request.get(`/api/files?path=${encodeURIComponent(path.join(directory, "image.png"))}`, {
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  const width = await page.locator("body").evaluate(() => globalThis.innerWidth);

  await page.route("**/api/files?*", (route) => route.continue());
  expect(image.ok()).toBeTruthy();
  expect(image.headers()["content-type"]).toBe("image/png");
  expect(pdf.ok()).toBeTruthy();
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toContain("inline");
  expect(denied.ok()).toBeFalsy();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Preserve native viewer draft");
  await page.getByRole("link", { name: "Image", exact: true }).click();
  await expect(page.locator(".file-viewer iframe")).toBeVisible();
  await expect
    .poll(async () =>
      page
        .frameLocator(".file-viewer iframe")
        .locator("img")
        .evaluate((element: HTMLImageElement) => element.naturalWidth)
    )
    .toBeGreaterThan(0);
  await dragEdge(page, SHORT_DRAG);
  await expect(page.getByRole("dialog")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await dragEdge(page, EDGE, VERTICAL_DRAG);
  await expect(page.getByRole("dialog")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await dragEdge(page, width / SWIPE_DIVISOR);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Preserve native viewer draft");
  await page.getByRole("link", { name: "PDF", exact: true }).click();
  await expect(page.locator(".file-viewer iframe")).toHaveAttribute("src", /document\.pdf/);
  await page.getByRole("button", { name: "Back to chat" }).click();
  await page.getByRole("link", { name: "Other", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download archive.bin" })).toHaveAttribute("download", "archive.bin");
  await info.attach("native-file-behavior", {
    body: JSON.stringify({
      imageType: image.headers()["content-type"],
      pdfType: pdf.headers()["content-type"],
      viewportWidth: width,
      rejectedDrag: SHORT_DRAG,
      acceptedDrag: width / SWIPE_DIVISOR,
      writes,
    }),
    contentType: "application/json",
  });
  expect(writes).toEqual([]);
});
