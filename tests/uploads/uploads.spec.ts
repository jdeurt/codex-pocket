import { type APIResponse, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { MAX_FILE_BYTES } from "../../src/lib/attachments";
import path from "node:path";
import sharp from "sharp";

const directory = path.resolve(".local/uploads-replay");
const origin = "http://127.0.0.1:3118";
const MIXED_FILE_COUNT = 3;
const control = (action: string) =>
  writeFile(path.join(directory, "control.json"), JSON.stringify({ id: crypto.randomUUID(), action }));

async function requests() {
  try {
    const text = await readFile(path.join(directory, "requests.jsonl"), "utf8");

    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function ok(promise: Promise<APIResponse>) {
  const response = await promise;

  return response.ok();
}

async function deliveredCount(id: string) {
  const entries = await requests();

  return entries.filter((entry) => entry.clientUserMessageId === id).length;
}

test("pick, retry, remove, file-only send, reload, queued recovery and real stored bytes", async ({ page }, info) => {
  await page.goto("/");
  const attach = page.getByRole("button", { name: "Attach images or files", exact: true });
  await expect(attach).toBeEnabled();
  await control("complete");
  await expect(page.locator("header [role=status]")).toHaveText("Connected");
  const picker = page.locator('input[type="file"]');
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const selected = page.getByRole("list", { name: "Selected attachments" });
  const png = await sharp({ create: { width: 100, height: 70, channels: 3, background: "#e38c39" } })
    .png()
    .toBuffer();
  const photoName = `${info.project.name}-photo.png`;
  const textName = `${info.project.name}-notes.txt`;
  const textBytes = Buffer.from("Readable uploaded notes.\nSecond line.");
  const photo = { name: photoName, mimeType: "image/png", buffer: png };
  const text = { name: textName, mimeType: "text/plain", buffer: textBytes };

  // Real native chooser activation, followed by browser file selection.
  const chooser = page.waitForEvent("filechooser");
  await attach.click();
  const nativeChooser = await chooser;
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
  await expect(page.getByRole("link", { name: `Download ${photoName}, ${png.length} B` })).toBeVisible();
  const photoRequests = await requests();
  const photoRequest = photoRequests.findLast((request) =>
    request.input.some((part: { type: string }) => part.type === "localImage")
  );
  expect(photoRequest.bytes[0].size).toBeGreaterThan(0);
  expect(photoRequest.input.map((part: { type: string }) => part.type)).toEqual(["localImage", "text"]);
  expect(Buffer.from(photoRequest.bytes[1].base64, "base64")).toEqual(png);

  // An upload failure keeps the Blob, survives reload, then retries using the same ID.
  let failedId = "";
  await page.route("**/api/uploads?**", async (route) => {
    if (route.request().method() === "PUT") {
      failedId = new URL(route.request().url()).searchParams.get("id") ?? "";
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
  const recoveredBytes = await page.request.get(`/api/uploads?id=${failedId}`);
  expect(await recoveredBytes.body()).toEqual(textBytes);

  const binaryName = `${info.project.name}-archive.bin`;
  const pdfName = `${info.project.name}-document.pdf`;
  const binary = Buffer.from("AP8eCsgtAH4=", "base64");
  await picker.setInputFiles([
    { name: binaryName, mimeType: "application/octet-stream", buffer: binary },
    { name: pdfName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nPocket test bytes\n%%EOF") },
  ]);
  await expect(selected.getByText("Ready to send", { exact: true })).toHaveCount(MIXED_FILE_COUNT);
  const message = `${info.project.name} files and text`;
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(message);
  // Lose the HTTP acknowledgement after Pocket has durably accepted the queue entry.
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
  const outbox = JSON.parse(await readFile(path.join(directory, "state/outbox.json"), "utf8"));
  const receipt = outbox.receipts.find((entry: { text: string }) => entry.text === message);
  expect(receipt.attachments).toHaveLength(MIXED_FILE_COUNT);
  expect(receipt.attachments[0].id).toBe(failedId);

  // Kill only the fake harness; reconnect hydrates the persisted outbox and history.
  await control("disconnect");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Reconnecting|Disconnected/ })
      .first()
  ).toBeVisible();
  await page.reload();
  await expect(attach).toBeEnabled();
  await expect(page.locator("header [role=status]")).toHaveText("Working");
  await control("complete");
  await expect.poll(() => deliveredCount(receipt.id)).toBe(1);
  const captured = await requests();
  const delivered = captured.find((request) => request.clientUserMessageId === receipt.id);
  expect(delivered.bytes).toHaveLength(MIXED_FILE_COUNT);
  expect(
    Buffer.from(delivered.bytes.find((file: { name: string }) => file.name === binaryName).base64, "base64")
  ).toEqual(binary);
  expect(
    Buffer.from(delivered.bytes.find((file: { name: string }) => file.name === textName).base64, "base64")
  ).toEqual(textBytes);
  await expect(page.getByRole("link", { name: new RegExp(`Download ${textName},`) }).last()).toBeVisible();
  await page.reload();
  await expect(selected).toHaveCount(0);
  const downloadLink = page.getByRole("link", { name: new RegExp(`Download ${binaryName},`) }).last();
  await expect(downloadLink).toBeVisible();
  const downloadUrl = await downloadLink.getAttribute("href");
  const download = await page.request.get(downloadUrl ?? "");
  expect(download.headers()["content-type"]).toBe("application/octet-stream");
  expect(download.headers()["content-disposition"]).toContain("attachment;");
  expect(await download.body()).toEqual(binary);
  await page.screenshot({ path: path.join(directory, `${info.project.name}-delivered.png`) });
  await control("complete");

  // Server image validation and client bounds keep recoverable errors near the selection.
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

test("API confines IDs, origins, filenames, content and retries", async ({ request }) => {
  const id = crypto.randomUUID();
  const url = `/api/uploads?${new URLSearchParams({ id, name: "safe.html", type: "text/html" })}`;
  const options = {
    headers: { Origin: origin, "Content-Type": "application/octet-stream" },
    data: Buffer.from("<script>alert('test')</script>"),
  };
  const first = await request.put(url, options);
  expect(first.ok()).toBeTruthy();
  const firstBody = await first.json();
  expect(firstBody.file.kind).toBe("file");
  expect(await ok(request.put(url, options))).toBeTruthy();
  expect(await ok(request.put(url, { ...options, data: Buffer.from("changed") }))).toBeFalsy();
  const downloaded = await request.get(`/api/uploads?id=${id}`);
  expect(downloaded.headers()["content-type"]).toBe("application/octet-stream");
  expect(downloaded.headers()["content-security-policy"]).toContain("sandbox");
  expect(
    await ok(request.put(`/api/uploads?id=${crypto.randomUUID()}&name=..%2Fevil&type=text%2Fplain`, options))
  ).toBeFalsy();
  expect(await ok(request.get("/api/uploads?id=../../etc/passwd"))).toBeFalsy();
  expect(await ok(request.get(`/api/uploads?id=${crypto.randomUUID()}`))).toBeFalsy();
  const unrelatedId = await readFile(path.join(directory, "unrelated-id.txt"), "utf8");
  expect(await ok(request.get(`/api/uploads?id=${unrelatedId}`))).toBeFalsy();
  expect(
    await ok(request.put(url, { ...options, headers: { ...options.headers, Origin: "https://evil.example" } }))
  ).toBeFalsy();
  expect(await ok(request.get(`/api/uploads?id=${id}&preview=1`))).toBeFalsy();
  const oversized = await request.put(
    `/api/uploads?id=${crypto.randomUUID()}&name=big.bin&type=application%2Foctet-stream`,
    { ...options, data: Buffer.alloc(MAX_FILE_BYTES + 1) }
  );
  expect(oversized.ok()).toBeFalsy();
  const emptyMessage = await request.post("/api/messages", {
    headers: { Origin: origin },
    data: { id: crypto.randomUUID(), text: "" },
  });
  expect(emptyMessage.ok()).toBeFalsy();
});

test("keyboard picker, upload progress, parent draft and IME sending", async ({ page }, info) => {
  await page.goto("/");
  const attach = page.getByRole("button", { name: "Attach images or files", exact: true });
  await expect(attach).toBeEnabled();
  await control("complete");
  await expect(page.locator("header [role=status]")).toHaveText("Connected");
  const textarea = page.getByRole("textbox", { name: "Message Pocket" });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const draft = `${info.project.name} keyboard draft`;
  await textarea.fill(draft);
  await page.reload();
  await expect(textarea).toHaveValue(draft);
  const uploadGate = Promise.withResolvers<boolean>();
  await page.route("**/api/uploads?**", async (route) => {
    if (route.request().method() === "PUT") {
      await uploadGate.promise;
    }

    await route.continue();
  });
  await expect(attach).toBeEnabled();
  await attach.focus();
  const chooser = page.waitForEvent("filechooser");
  await attach.press("Enter");
  const nativeChooser = await chooser;
  const name = `${info.project.name}-keyboard.txt`;
  await nativeChooser.setFiles({ name, mimeType: "text/plain", buffer: Buffer.from("Keyboard upload") });
  const selected = page.getByRole("list", { name: "Selected attachments" });
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

  if (info.project.name === "desktop-chromium") {
    await textarea.press("Enter");
  } else {
    await textarea.press("Enter");
    await expect(textarea).toHaveValue(`${draft}\n`);
    await send.click();
  }

  await expect(textarea).toHaveValue("");
  await expect
    .poll(async () => {
      const entries = await requests();

      return entries.filter((entry) => entry.input.some((part: { text?: string }) => part.text === draft)).length;
    })
    .toBe(1);
  await control("complete");
});

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
  expect(sourceMetadata.pages).toBe(2);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Attach images or files", exact: true })).toBeEnabled();
  await control("complete");
  await expect(page.locator("header [role=status]")).toHaveText("Connected");
  const name = `${info.project.name}-animated-spinner.gif`;
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/gif", buffer: gif });
  await expect(
    page.getByRole("list", { name: "Selected attachments" }).getByText("Ready to send", { exact: true })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Selected attachments" }).getByText("Ready to send", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("list", { name: "Selected attachments" })).toHaveCount(0);
  const captured = await requests();
  const delivered = captured.findLast((request) => request.bytes.some((file: { name?: string }) => file.name === name));
  expect(delivered.input.map((part: { type: string }) => part.type)).toEqual(["localImage", "text"]);
  const original = delivered.bytes.find((file: { name?: string }) => file.name === name);
  expect(original.mediaType).toBe("image/gif");
  expect(Buffer.from(original.base64, "base64")).toEqual(gif);
  const durableBytes = await readFile(original.path);
  expect(durableBytes).toEqual(gif);
  const metadata = await sharp(durableBytes, { animated: true }).metadata();
  expect(metadata.pages).toBe(2);
  expect(metadata.delay).toEqual(sourceMetadata.delay);
  expect(metadata.loop).toBe(0);
  const imagePath = delivered.input.find((part: { type: string }) => part.type === "localImage").path;
  expect(imagePath).not.toBe(original.path);
  const preview = await sharp(imagePath).metadata();
  expect(preview.format).toBe("png");
  const link = page.getByRole("link", { name: new RegExp(`Download ${name},`) });
  const url = await link.getAttribute("href");
  const download = await page.request.get(url ?? "");
  expect(await download.body()).toEqual(gif);
  await page.reload();
  expect(await readFile(original.path)).toEqual(gif);
  await expect(link).toBeVisible();
  await control("complete");
});
