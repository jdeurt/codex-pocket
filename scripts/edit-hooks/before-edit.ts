import { before, clearInterruptedTurn } from "./tracking";
import { bookkeepingEvent, nativeInput } from "./events";

/**
Record the before-tool snapshot without controlling the tool.
*/
async function prepare(): Promise<void> {
  const event = await bookkeepingEvent(await nativeInput());

  if (event) {
    if ("hook_event_name" in event) {
      await clearInterruptedTurn(event.session_id, event.turn_id);
    } else {
      await before(event);
    }
  }
}

try {
  await prepare();
} catch {
  // Bookkeeping failure cannot deny or alter the edit.
}
