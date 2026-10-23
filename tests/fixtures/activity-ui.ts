import { type Snapshot } from "../../src/lib/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";

/** Render the production activity component after disabling CSS evaluation in Node only.
@param state - Actual adapter snapshot delivered to the phone.
@param expected - Expected human status, absent after a terminal lifecycle event.
*/
export async function checkActivityUi(state: Snapshot, expected: string | undefined) {
  await import("./restart-css-loader.mjs");
  const { ConversationActivity } = await import("../../src/components/conversation-activity");
  const markup = renderToStaticMarkup(createElement(ConversationActivity, { state }));

  assert.equal(state.activity, expected);

  if (expected === undefined) {
    assert.doesNotMatch(markup, /aria-label="Pocket activity"/);
  } else if (expected) {
    assert.ok(markup.includes(`>${expected}</span>`), markup);
  } else {
    assert.doesNotMatch(markup, /Considering options|considering options/);
  }
}
