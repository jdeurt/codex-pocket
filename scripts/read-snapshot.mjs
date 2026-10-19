/** Read the first complete data event, including frames split across network chunks.
@param {ReadableStream<Uint8Array>} body
@returns {Promise<unknown>}
*/
export async function readSnapshot(body) {
  const reader = body.getReader();
  const decoder = new globalThis.TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        throw new Error("Snapshot stream ended before a complete data event.");
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);

      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r\n|\n|\r/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /, ""));

        if (data.length > 0) {
          return JSON.parse(data.join("\n"));
        }

        boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
