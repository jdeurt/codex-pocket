/**
Collects data lines from one complete SSE frame while ignoring keepalives.
@param frame - Complete frame without its terminating blank line.
@returns Joined event data, or undefined when this frame contains no data lines.
*/
function frameData(frame: string) {
  const data = frame
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""));

  return data.length > 0 ? data.join("\n") : undefined;
}

/**
Retains fragmented UTF-8 bytes and incomplete SSE frames until a data event is complete.
*/
class SnapshotFrames {
  private buffer = "";
  private decoder = new TextDecoder();

  /**
  Removes exactly one complete frame from the accumulated stream text.
  @param boundary - Located blank-line terminator in the current buffer.
  @returns Frame text before its terminator.
  */
  private takeFrame(boundary: RegExpExecArray) {
    const frame = this.buffer.slice(0, boundary.index);

    this.buffer = this.buffer.slice(boundary.index + boundary[0].length);

    return frame;
  }

  /**
  Skips complete keepalives and returns the first complete data frame.
  @returns Event data, or undefined when more network bytes are required.
  */
  private nextData() {
    let boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);

    while (boundary) {
      const data = frameData(this.takeFrame(boundary));

      if (data !== undefined) {
        return data;
      }

      boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    }
  }

  /**
  Decodes another network chunk without discarding a split UTF-8 code point.
  @param value - Next byte chunk from the actual HTTP response.
  @returns First complete event data, or undefined while the event is incomplete.
  */
  push(value: Uint8Array) {
    this.buffer += this.decoder.decode(value, { stream: true });

    return this.nextData();
  }
}

/**
Reads until the first complete SSE data event, leaving its JSON payload unknown.
@param reader - Owned HTTP stream reader.
@returns Decoded unknown JSON; incomplete EOF or malformed JSON rejects.
*/
async function readData(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const frames = new SnapshotFrames();

  let next = await reader.read();

  while (!next.done) {
    const data = frames.push(next.value);

    if (data !== undefined) {
      const payload: unknown = JSON.parse(data);

      return payload;
    }

    next = await reader.read();
  }

  throw new Error("Snapshot stream ended before a complete data event.");
}

/**
Cancels the actual response and releases its reader even when cancellation rejects.
@param reader - Stream reader owned by this one snapshot request.
@returns Completion of cancellation and reader release.
*/
async function closeReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  await reader.cancel().finally(() => {
    reader.releaseLock();
  });
}

/**
Reads the first complete data event, including frames split across network chunks.
@param body - Actual SSE response body owned by this request.
@returns Unknown JSON for the caller's canonical snapshot schema to validate.
*/
export async function readSnapshot(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = body.getReader();

  return readData(reader).finally(async () => {
    await closeReader(reader);
  });
}
