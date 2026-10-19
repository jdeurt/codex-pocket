import { type Snapshot, string } from "../lib/protocol";

// Only messages and explicitly projected display items leave the computer.
export function visibleSnapshot(state: Snapshot): Snapshot {
  const scheduled = new Map(Object.entries(state.scheduled ?? {}));

  return {
    ...state,
    notices: [],
    queue: state.queue.map((message) => {
      const marker = scheduled.get(message.id);

      return marker ? { ...message, text: "", scheduled: marker } : message;
    }),
    turns: state.turns.map((turn) => ({
      ...turn,
      items: turn.items
        .filter((item) => ["userMessage", "agentMessage"].includes(item.type))
        .map((item) => {
          const marker = item.type === "userMessage" ? scheduled.get(string(item.clientId)) : undefined;

          return marker ? { id: item.id, clientId: item.clientId, type: "scheduledTask", ...marker } : item;
        }),
    })),
  };
}
