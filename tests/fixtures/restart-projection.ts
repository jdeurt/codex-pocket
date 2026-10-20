import { Children, type ReactNode, createElement, isValidElement } from "react";
import { type TurnEntry, turnMessages } from "../../src/lib/turn-messages";
import { Conversation } from "../../src/components/conversation";
import type { Snapshot } from "../../src/lib/protocol";
import { TurnMessages } from "../../src/components/turn-messages";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

interface TranscriptProps {
  entries?: TurnEntry[];
  turns?: { entries: TurnEntry[] }[];
  children?: ReactNode;
}

// Read the actual Conversation projection without assuming measured virtual rows exist during SSR.
function projectedEntries(node: ReactNode): TurnEntry[] {
  if (!isValidElement<TranscriptProps>(node)) {
    return [];
  }

  const { entries, turns, children } = node.props;

  return (
    entries ??
    turns?.flatMap((turn) => turn.entries) ??
    Children.toArray(children).flatMap((child) => projectedEntries(child))
  );
}

const items = (entries: TurnEntry[]) =>
  entries.flatMap((entry) => (entry.kind === "message" ? [entry.item] : entry.items));
const markup = (entries: TurnEntry[]) => renderToStaticMarkup(createElement(TurnMessages, { entries }));

export function verifyRestartProjection(state: Snapshot) {
  const canonical = state.turns.flatMap((turn) =>
    turnMessages(turn, turn.id === state.activeTurnId || turn.status === "inProgress")
  );
  const writable = projectedEntries(Conversation({ state }));

  assert.deepEqual(writable, canonical);
  const expectedEvents = state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "pocketRestart");

  assert.equal(expectedEvents.length, 1);
  assert.deepEqual(
    items(writable).filter((item) => item.type === "pocketRestart"),
    expectedEvents
  );
  const displayed = markup(writable);

  assert.equal((displayed.match(/data-system-event="pocket-restarted"/g) ?? []).length, expectedEvents.length);
  assert.match(displayed, /Pocket restarted/);
  assert.doesNotMatch(displayed, /data-message-id="empty-/);

  const readOnly = projectedEntries(Conversation({ state, readOnly: true }));

  assert.deepEqual(
    items(readOnly),
    items(writable).filter((item) => item.type !== "pocketRestart")
  );
  const excluded = markup(readOnly);

  assert.doesNotMatch(excluded, /Pocket restarted|data-system-event=/);
  assert.match(excluded, /Original user content must remain unchanged/);
}
