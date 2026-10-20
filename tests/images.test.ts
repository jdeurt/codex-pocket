import { imageUrl, itemImageSources, thumbnailUrl } from "../src/lib/images";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { initialSnapshot } from "../src/lib/protocol";
import os from "node:os";
import path from "node:path";
import { redactLog } from "../src/server/logging";
import { renderImage } from "../src/server/images";
import sharp from "sharp";
import test from "node:test";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const ICON_SIZE = 192;

await test("image references support generated output, MCP, dynamic tools and local user attachments", () => {
  assert.deepEqual(
    itemImageSources({ id: "generated", type: "imageGeneration", result: "aGVsbG8=", savedPath: "/tmp/generated.png" }),
    ["/tmp/generated.png"]
  );
  assert.deepEqual(
    itemImageSources({
      id: "mcp",
      type: "mcpToolCall",
      result: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    }),
    ["data:image/png;base64,aGVsbG8="]
  );
  assert.deepEqual(
    itemImageSources({
      id: "dynamic",
      type: "dynamicToolCall",
      contentItems: [{ type: "inputImage", imageUrl: "https://example.com/image.png" }],
    }),
    ["https://example.com/image.png"]
  );
  assert.deepEqual(
    itemImageSources({ id: "user", type: "userMessage", content: [{ type: "localImage", path: "/tmp/photo.jpg" }] }),
    ["/tmp/photo.jpg"]
  );
  assert.match(imageUrl("file:///tmp/my photo.png"), /^\/api\/images\?path=/);
  assert.equal(imageUrl("javascript:alert(1)"), "");
  assert.equal(thumbnailUrl("/api/images?item=test&index=0"), "/api/images?item=test&index=0&thumbnail=1");
});

await test("client snapshots project tool images without sending tool arguments or image bytes", () => {
  const state = structuredClone(initialSnapshot);
  state.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        { id: "image", type: "imageGeneration", result: "private-base64", revisedPrompt: "private tool prompt" },
        { id: "tool", type: "commandExecution", aggregatedOutput: "private shell output" },
      ],
    },
  ];
  const visible = visibleSnapshot(state);
  assert.equal(visible.turns[0].items[0].type, "imageOutput");
  assert.equal(visible.turns[0].items.length, 1);
  assert.equal(JSON.stringify(visible).includes("private"), false);
});

await test("local and inline images render safely while non-images and remote fetches are rejected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-images-"));
  process.env.CODEX_POCKET_LOG_DIR = path.join(directory, "logs");

  try {
    const input = await readFile("public/icon-192.png");
    await writeFile(path.join(directory, "image.png"), input);
    await writeFile(path.join(directory, "not-an-image.png"), "<html>Not an image</html>");
    const rendered = await renderImage("image.png", directory, true);
    const metadata = await sharp(rendered.bytes).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, ICON_SIZE);
    assert.equal(metadata.height, ICON_SIZE);
    const inline = await renderImage(`data:image/png;base64,${input.toString("base64")}`, directory, true);
    assert.equal(inline.etag, rendered.etag);
    await assert.rejects(() => renderImage("not-an-image.png", directory, true));
    await assert.rejects(() => renderImage("https://example.com/private", directory, true), /Only local/);
    await assert.rejects(() => renderImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", directory, true));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("image diagnostics retain sizes and saved paths without repeating megabytes of base64", () => {
  const entry = { type: "imageGeneration", result: "base64-content", savedPath: "/tmp/image.png" };
  const output = JSON.stringify(redactLog(entry));
  assert.equal(output.includes("base64-content"), false);
  assert.equal(output.includes("/tmp/image.png"), true);
  assert.equal(entry.result, "base64-content");
});
