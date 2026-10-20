import { Children, type ComponentProps, type ReactNode, createElement, isValidElement } from "react";
import { type TurnEntry, turnMessages } from "../../src/lib/turn-messages";
import { Conversation } from "../../src/components/conversation";
import type { Snapshot } from "../../src/lib/protocol";
import { TurnMessages } from "../../src/components/turn-messages";
import { VirtualizedTranscript } from "../../src/components/virtualized-transcript";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

/**
Reads the real transcript component's props without assuming virtual rows exist during SSR.
@param node - Actual element returned by Conversation.
@returns Canonical entries passed to the supported transcript component.
*/
function projectedEntries(node: ReactNode): TurnEntry[] {
  const transcript = isValidElement<{ children: ReactNode }>(node)
    ? Children.toArray(node.props.children).find(
        (child) => isValidElement(child) && child.type === VirtualizedTranscript
      )
    : undefined;

  assert.ok(isValidElement<ComponentProps<typeof VirtualizedTranscript>>(transcript));

  return transcript.props.turns.flatMap((turn) => turn.entries);
}

/**
Flattens projected message and activity entries without changing their item order.
@param entries - Canonical transcript entries supplied by the real Conversation.
@returns Native items represented by these entries.
*/
function items(entries: TurnEntry[]) {
  return entries.flatMap((entry) => (entry.kind === "message" ? [entry.item] : entry.items));
}

/**
Renders the actual turn-message component after the native fixture disables only CSS evaluation.
@param entries - Canonical entries to render.
@returns Native React SSR markup.
*/
function markup(entries: TurnEntry[]) {
  return renderToStaticMarkup(createElement(TurnMessages, { entries }));
}

/**
Checks writable restart markup and excludes silent native rows from actual rendering.
@param writable - Actual writable Conversation entries.
@param expectedCount - Canonical restart event count.
*/
function verifyWritableMarkup(writable: TurnEntry[], expectedCount: number) {
  const displayed = markup(writable);

  assert.equal((displayed.match(/data-system-event="pocket-restarted"/g) ?? []).length, expectedCount);
  assert.match(displayed, /Pocket restarted/);
  assert.doesNotMatch(displayed, /data-message-id="empty-/);
}

/**
Checks read-only rendering excludes restart chrome while preserving ordinary user content.
@param readOnly - Actual read-only Conversation entries.
*/
function verifyReadOnlyMarkup(readOnly: TurnEntry[]) {
  const excluded = markup(readOnly);

  assert.doesNotMatch(excluded, /Pocket restarted|data-system-event=/);
  assert.match(excluded, /Original user content must remain unchanged/);
}

/**
Checks the real read-only projection differs only by its excluded restart notices.
@param state - Canonical snapshot supplied to Conversation.
@param writable - Already verified writable Conversation entries.
*/
function verifyReadOnlyProjection(state: Snapshot, writable: TurnEntry[]) {
  const readOnly = projectedEntries(Conversation({ state, readOnly: true }));

  assert.deepEqual(
    items(readOnly),
    items(writable).filter((item) => item.type !== "pocketRestart")
  );
  verifyReadOnlyMarkup(readOnly);
}

/**
Checks canonical entries, writable markup and read-only projection through the real components.
@param state - Native snapshot with one expected restart notice and preserved original user content.
*/
export function verifyRestartProjection(state: Snapshot) {
  const canonical = state.turns.flatMap((turn) =>
    turnMessages(turn, turn.id === state.activeTurnId || turn.status === "inProgress")
  );
  const writable = projectedEntries(Conversation({ state }));
  const expectedEvents = state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "pocketRestart");

  assert.deepEqual(writable, canonical);
  assert.equal(expectedEvents.length, 1);
  assert.deepEqual(
    items(writable).filter((item) => item.type === "pocketRestart"),
    expectedEvents
  );
  verifyWritableMarkup(writable, expectedEvents.length);
  verifyReadOnlyProjection(state, writable);
}
