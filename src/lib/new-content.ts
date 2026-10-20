import { type Snapshot, string } from "./protocol";

/**
Mark changed assistant source only after a connected baseline, excluding historical prepends and reconnect hydration.
@param previous - Last canonical snapshot before the incoming event.
@param next - Incoming canonical snapshot whose source remains unchanged.
@returns Snapshot with transient source offsets for opacity-only reveal.
*/
export function markNewContent(previous: Snapshot, next: Snapshot): Snapshot {
  const active = next.activeTurnId ?? previous.activeTurnId;
  const before = new Map(previous.turns.flatMap((turn) => turn.items.map((item) => [item.id, string(item.text)])));

  if (previous.connection !== "connected" || next.connection !== "connected" || previous.threadId !== next.threadId) {
    return next;
  }

  return {
    ...next,
    turns: next.turns.map((turn) =>
      turn.id !== active
        ? turn
        : {
            ...turn,
            items: turn.items.map((item) => {
              const text = string(item.text);
              const old = before.get(item.id) ?? "";
              let from = 0;

              if (item.type !== "agentMessage" || text === old) {
                return item;
              }
              while (from < Math.min(old.length, text.length) && old[from] === text[from]) {
                from++;
              }

              return { ...item, revealFrom: from, revealId: `${item.id}:${String(performance.now())}` };
            }),
          }
    ),
  };
}
