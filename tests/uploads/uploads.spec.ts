import { MAX_FILE_BYTES, attachmentUrl } from "../../src/lib/attachments";
import { control, deliveredCount, directory, requests } from "./replay-state";
import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import { outboxSchema } from "../../src/server/outbox";
import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const MIXED_FILE_COUNT = 3;

test("pick, retry, remove, file-only send, reload, queued recovery and real stored bytes", async ({ page }, info) => {
  const attach = page.getByRole("button", { name: "Attach images or files", exact: true });
  const picker = page.locator('input[type="file"]');
  const send = page.getByRole("button", { name: /^Send message(?:;|$)/ });
  const selected = page.getByRole("list", { name: "Selected attachments" });
  const png = await test.step("Connect the offline upload session", async () => {
    await page.goto("/");
    await expect(attach).toBeEnabled();
    await control("complete");
    await expect(page.locator("header [role=status]")).toHaveText("Connected");

    return await sharp({ create: { width: 100, height: 70, channels: 3, background: "#e38c39" } })
      .png()
      .toBuffer();
  });
  const photoName = `${info.project.name}-photo.png`;
  const textName = `${info.project.name}-notes.txt`;
  const textBytes = Buffer.from("Readable uploaded notes.\nSecond line.");
  const photo = { name: photoName, mimeType: "image/png", buffer: png };
  const text = { name: textName, mimeType: "text/plain", buffer: textBytes };
  const photoRequests = await test.step("Select, remove, restore and send a native photo", async () => {
    const nativeChooser = await test.step("Activate the native file chooser", async () => {
      const chooser = page.waitForEvent("filechooser");

      await attach.click();

      return await chooser;
    });

    await nativeChooser.setFiles([photo, text]);
    await expect(selected.getByText("Ready to send", { exact: true })).toHaveCount(2);
    await expect(send).toBeEnabled();
    await selected.getByRole("button", { name: `Remove ${textName}` }).click();
    await expect(selected.getByText(textName, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(selected.getByText(photoName, { exact: true })).toBeVisible();
    await expect(selected.getByText("Ready to send", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(directory, `${info.project.name}-selected.png`) });
    await send.click();
    await expect(selected).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Attachments", exact: true }).getByText(photoName, { exact: true })
    ).toBeVisible();

    return await requests();
  });
  const failedId = await test.step("Verify photo bytes and recover an interrupted file upload", async () => {
    const photoRequest = photoRequests.findLast((request) => request.input.some((part) => part.type === "localImage"));

    let interruptedId = "";

    assert.ok(photoRequest);
    expect(photoRequest.bytes[0].size).toBeGreaterThan(0);
    expect(photoRequest.input.map((part) => part.type)).toEqual(["localImage", "text"]);
    expect(Buffer.from(photoRequest.files[0].base64, "base64")).toEqual(png);
    // Keep the Blob across reload and retry the same upload identity.
    await page.route("**/api/uploads?**", async (route) => {
      if (route.request().method() === "PUT") {
        interruptedId = new URL(route.request().url()).searchParams.get("id") ?? "";
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    await picker.setInputFiles([text]);
    await expect(selected.getByText(/Upload interrupted/)).toBeVisible();
    await page.unroute("**/api/uploads?**");
    await page.reload();
    await selected.getByRole("button", { name: `Retry ${textName}` }).click();
    await expect(selected.getByText("Ready to send", { exact: true })).toBeVisible();

    return interruptedId;
  });
  const recoveredBytes = await page.request.get(`/api/uploads?id=${failedId}`);
  const binaryName = `${info.project.name}-archive.bin`;
  const pdfName = `${info.project.name}-document.pdf`;
  const binary = Buffer.from("AP8eCsgtAH4=", "base64");
  const receipt = await test.step("Queue mixed files after losing the HTTP acknowledgement", async () => {
    expect(await recoveredBytes.body()).toEqual(textBytes);
    await picker.setInputFiles([
      { name: binaryName, mimeType: "application/octet-stream", buffer: binary },
      { name: pdfName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nPocket test bytes\n%%EOF") },
    ]);
    await expect(selected.getByText("Ready to send", { exact: true })).toHaveCount(MIXED_FILE_COUNT);

    return await test.step("Retry the durably accepted message and inspect its receipt", async () => {
      const message = `${info.project.name} files and text`;

      await page.getByRole("textbox", { name: "Message Pocket" }).fill(message);
      await page.route("**/api/messages", async (route) => {
        await route.fetch();
        await route.abort("failed");
      });
      await send.click();
      await expect(page.getByText(/Your message is saved here/)).toBeVisible();
      await page.unroute("**/api/messages");
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(message);
      await expect(selected.getByText("Ready to send", { exact: true })).toHaveCount(MIXED_FILE_COUNT);
      await send.click();
      await expect(selected).toHaveCount(0);
      await expect(page.getByText("Queued", { exact: true }).last()).toBeVisible();

      return await test.step("Read the durable outbox receipt", async () => {
        const source = await readFile(path.join(directory, "state/outbox.json"), "utf8");
        const outbox = outboxSchema.parse(JSON.parse(source));
        const queued = outbox.receipts.find((entry) => entry.text === message);

        assert.ok(queued?.attachments);
        expect(queued.attachments).toHaveLength(MIXED_FILE_COUNT);
        expect(queued.attachments[0].id).toBe(failedId);

        return queued;
      });
    });
  });

  await test.step("Reconnect and deliver the persisted submission exactly once", async () => {
    // Hold the fake harness offline until the browser observes the outage.
    await control("disconnect");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Connecting|Reconnecting|Disconnected/ })
        .first()
    ).toBeVisible();
    await control("reconnect");
    await page.reload();
    await expect(attach).toBeEnabled();
    await expect(page.locator("header [role=status]")).toHaveText("Working");
    await control("complete");
    await expect.poll(() => deliveredCount(receipt.id)).toBe(1);
    await test.step("Verify native mixed-file receipts", async () => {
      const captured = await requests();
      const delivered = captured.find((request) => request.clientUserMessageId === receipt.id);

      assert.ok(delivered);
      expect(delivered.bytes).toHaveLength(MIXED_FILE_COUNT);
      expect(Buffer.from(delivered.files.find((file) => file.name === binaryName)?.base64 ?? "", "base64")).toEqual(
        binary
      );
      expect(Buffer.from(delivered.files.find((file) => file.name === textName)?.base64 ?? "", "base64")).toEqual(
        textBytes
      );
    });
    await expect(
      page.getByRole("list", { name: "Attachments", exact: true }).getByText(textName, { exact: true }).last()
    ).toBeVisible();
    await page.reload();
    await expect(selected).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Attachments", exact: true }).getByText(binaryName, { exact: true }).last()
    ).toBeVisible();
    await test.step("Download the managed binary attachment", async () => {
      const download = await test.step("Resolve the confirmed managed attachment", async () => {
        const binaryFile = receipt.attachments?.find((file) => file.name === binaryName);

        assert.ok(binaryFile);

        return await page.request.get(attachmentUrl(binaryFile.id));
      });

      expect(download.headers()["content-type"]).toBe("application/octet-stream");
      expect(download.headers()["content-disposition"]).toContain("attachment;");
      expect(await download.body()).toEqual(binary);
    });
    await page.screenshot({ path: path.join(directory, `${info.project.name}-delivered.png`) });
    await control("complete");
  });
  await test.step("Keep validation errors recoverable beside attachment selection", async () => {
    await picker.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await expect(selected.getByText(/This image couldn't be read/)).toBeVisible();
    await expect(send).toBeDisabled();
    await selected.getByRole("button", { name: "Remove broken.png" }).click();
    await picker.setInputFiles({
      name: "too-big.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(MAX_FILE_BYTES + 1),
    });
    await expect(page.getByText("Choose nonempty files up to 25 MB each.")).toBeVisible();
    await expect(selected).toHaveCount(0);
  });
});

test("keyboard picker, upload progress, parent draft and IME sending", async ({ page, isMobile }, info) => {
  const attach = page.getByRole("button", { name: "Attach images or files", exact: true });
  const textarea = page.getByRole("textbox", { name: "Message Pocket" });
  const send = page.getByRole("button", { name: /^Send message(?:;|$)/ });
  const selected = page.getByRole("list", { name: "Selected attachments" });
  const draft = await test.step("Connect the parent draft session", async () => {
    await page.goto("/");
    await expect(attach).toBeEnabled();
    await control("complete");
    await expect(page.locator("header [role=status]")).toHaveText("Connected");

    return `${info.project.name} keyboard draft`;
  });
  const uploadGate = await test.step("Restore the parent draft after reload", async () => {
    await textarea.fill(draft);
    await page.reload();
    await expect(textarea).toHaveValue(draft);

    return Promise.withResolvers<boolean>();
  });
  const nativeChooser = await test.step("Activate the keyboard picker while uploads are gated", async () => {
    await page.route("**/api/uploads?**", async (route) => {
      if (route.request().method() === "PUT") {
        await uploadGate.promise;
      }

      await route.continue();
    });
    await expect(attach).toBeEnabled();
    await attach.focus();

    return await test.step("Press Enter on the native chooser", async () => {
      const chooser = page.waitForEvent("filechooser");

      await attach.press("Enter");

      return await chooser;
    });
  });
  const name = `${info.project.name}-keyboard.txt`;

  await nativeChooser.setFiles({ name, mimeType: "text/plain", buffer: Buffer.from("Keyboard upload") });
  await expect(selected.getByRole("progressbar", { name: `Uploading ${name}` })).toBeVisible();
  await expect(send).toBeDisabled();
  uploadGate.resolve(true);
  await expect(selected.getByText("Ready to send", { exact: true })).toBeVisible();
  await textarea.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(textarea).toHaveValue(draft);
  await selected.getByRole("button", { name: `Remove ${name}` }).click();
  await textarea.press("Shift+Enter");
  await expect(textarea).toHaveValue(`${draft}\n`);
  await textarea.fill(draft);
  await textarea.press("Enter");

  if (isMobile) {
    await expect(textarea).toHaveValue(`${draft}\n`);
    await send.click();
  }

  await expect(textarea).toHaveValue("");
  await expect
    .poll(async () => {
      const entries = await requests();

      return entries.filter((entry) => entry.input.some((part) => part.type === "text" && part.text === draft)).length;
    })
    .toBe(1);
  await control("complete");
});
