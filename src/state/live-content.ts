/** Split context without breaking Unicode characters, using bytes as a conservative token bound.
@param text - Explicit context or verified backend result.
@param limit - Maximum UTF-8 bytes in one chunk.
@returns Ordered nonempty chunks whose byte lengths fit the limit.
*/
export function liveContentChunks(text: string, limit: number) {
  const encoder = new TextEncoder();
  const chunks: string[] = [];

  let chunk = "";
  let bytes = 0;

  for (const character of text) {
    const size = encoder.encode(character).length;

    if (chunk && bytes + size > limit) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }

    chunk += character;
    bytes += size;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks;
}
