import { type Item, type Snapshot, string } from "./protocol";

/**
Find the changed suffix at a grapheme boundary so Unicode text is never split between spans.
@param old - Previous assistant source.
@param text - Incoming assistant source.
@returns First changed grapheme's source offset.
*/
function changedOffset(old: string, text: string) {
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);

  let from = 0;
  let boundary = 0;

  while (from < Math.min(old.length, text.length) && old[from] === text[from]) {
    from++;
  }

  for (const segment of segments) {
    if (segment.index > from) {
      break;
    }

    boundary = segment.index;
  }

  return boundary;
}

/**
Annotate changed assistant content while leaving source and earlier visible text intact.
@param item - Incoming native transcript item.
@param before - Last known assistant source by stable item identity.
@returns Existing item or a transient reveal annotation.
*/
function markItem(item: Item, before: Map<string, string>): Item {
  const text = string(item.text);
  const old = before.get(item.id) ?? "";

  return text === old || item.type !== "agentMessage"
    ? item
    : { ...item, revealFrom: changedOffset(old, text), revealId: `${item.id}:${String(performance.now())}` };
}

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
      turn.id === active
        ? {
            ...turn,
            items: turn.items.map((item) => markItem(item, before)),
          }
        : turn
    ),
  };
}
