import assert from "node:assert/strict";
import { readSnapshot } from "../scripts/read-snapshot.mjs";
import test from "node:test";

function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}

await test("snapshot reads wait for a complete event across large fragmented UTF-8 frames and keepalives", async () => {
  const REPEATS = 20_000;
  const CHUNK_BYTES = 2047;
  const state = { connection: "connected", text: "A reply 👋 with quoted text. ".repeat(REPEATS) };
  const bytes = new TextEncoder().encode(`: keepalive\r\n\r\ndata: ${JSON.stringify(state)}\r\n\r\n`);
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, offset + CHUNK_BYTES));
  }

  assert.deepEqual(await readSnapshot(stream(chunks)), state);
});

await test("snapshot reads reject an incomplete final frame instead of parsing a partial JSON chunk", async () => {
  const chunks = [new TextEncoder().encode('data: {"text":"not finished')];

  await assert.rejects(readSnapshot(stream(chunks)), /before a complete data event/);
});
