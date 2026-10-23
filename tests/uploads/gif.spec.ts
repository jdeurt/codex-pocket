import { control, requests } from "./replay-state";
import { expect } from "@playwright/test";
import { test } from "../fixtures/browser-workflow";
import assert from "node:assert/strict";
import { attachmentUrl } from "../../src/lib/attachments";
import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

test("animated GIF exposes its durable original path to harness tools", async ({ page }, info) => {
  const edge = 16;
  const channels = 3;
  const white = 0xff;
  const firstDelay = 80;
  const secondDelay = 120;
  const frame = Buffer.alloc(edge * edge * channels);
  const gif = await sharp(Buffer.concat([frame, Buffer.alloc(frame.length, white)]), {
    raw: { width: edge, height: edge * 2, channels, pageHeight: edge },
  })
    .gif({ delay: [firstDelay, secondDelay], loop: 0 })
    .toBuffer();
  const sourceMetadata = await sharp(gif, { animated: true }).metadata();
  const name = await test.step("Connect the animated upload session", async () => {
    expect(sourceMetadata.pages).toBe(2);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Attach images or files", exact: true })).toBeEnabled();
    await control("complete");
    await expect(page.locator("header [role=status]")).toHaveText("Connected");

    return `${info.project.name}-animated-spinner.gif`;
  });
  const captured = await test.step("Send the restored animated selection", async () => {
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/gif", buffer: gif });
    await expect(
      page.getByRole("list", { name: "Selected attachments" }).getByText("Ready to send", { exact: true })
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("list", { name: "Selected attachments" }).getByText("Ready to send", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: /^Send message(?:;|$)/ }).click();
    await expect(page.getByRole("list", { name: "Selected attachments" })).toHaveCount(0);

    return await requests();
  });
  const { delivered, original } = await test.step("Inspect the native animated-file receipt", () => {
    const capturedDelivery = captured.findLast((request) => request.files.some((file) => file.name === name));

    const fileReceipt = capturedDelivery?.files.find((file) => file.name === name);

    assert.ok(capturedDelivery);
    expect(capturedDelivery.input.map((part) => part.type)).toEqual(["localImage", "text"]);
    assert.ok(fileReceipt);

    return { delivered: capturedDelivery, original: fileReceipt };
  });
  const durableBytes = await test.step("Read the original managed GIF bytes", async () => {
    expect(original.mediaType).toBe("image/gif");
    expect(Buffer.from(original.base64, "base64")).toEqual(gif);

    return await readFile(original.path);
  });
  const metadata = await test.step("Verify original byte preservation", async () => {
    expect(durableBytes).toEqual(gif);

    return await sharp(durableBytes, { animated: true }).metadata();
  });
  const imagePath = await test.step("Preserve animation metadata and native preview input", () => {
    const imageInput = delivered.input.find((part) => part.type === "localImage");

    expect(metadata.pages).toBe(2);
    expect(metadata.delay).toEqual(sourceMetadata.delay);
    expect(metadata.loop).toBe(0);
    assert.ok(imageInput);

    return imageInput.path;
  });
  const preview = await test.step("Keep native preview separate from original bytes", async () => {
    expect(imagePath).not.toBe(original.path);

    return await sharp(imagePath).metadata();
  });
  const fileCard = page.getByRole("list", { name: "Attachments", exact: true }).getByText(name, { exact: true });
  const download = await test.step("Download the managed animated original", async () => {
    const managedId = path.basename(path.dirname(original.path));

    expect(preview.format).toBe("png");

    return await page.request.get(attachmentUrl(managedId));
  });

  expect(await download.body()).toEqual(gif);
  await page.reload();
  expect(await readFile(original.path)).toEqual(gif);
  await expect(fileCard).toBeVisible();
  await control("complete");
});
