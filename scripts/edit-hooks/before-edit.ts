import { before } from "./tracking";
import { nativeEvent } from "./shared";

/**
Record the before-tool snapshot without controlling the tool.
*/
async function prepare(): Promise<void> {
  const event = await nativeEvent();

  if (event) {
    await before(event);
  }
}

try {
  await prepare();
} catch {
  // Bookkeeping failure cannot deny or alter the edit.
}
