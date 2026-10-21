import { GUIDANCE, HEADER, assertIdle, fixture, hook, hookMessage } from "./edit-hooks-fixture";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const MAX_FEEDBACK_DIAGNOSTICS = 20;

/** Check that presentation truncation does not limit persisted occurrences.
@param message - Native hook feedback.
*/
function assertTruncatedFeedback(message: string): void {
  assert.match(message, /\(eqeqeq\)/);
  assert.equal(message.split("\n").filter((line) => line.includes("(eqeqeq)")).length, MAX_FEEDBACK_DIAGNOSTICS);
}

/** Check normal diagnostic context and the separate persistence warning.
@param root - Disposable checkout.
@param event - Completed native tool event.
*/
function assertCounterFailureFeedback(
  root: string,
  event: { session_id: string; tool_use_id: string; cwd: string; tool_name: string }
): void {
  const message = hookMessage(root, event);

  assert.ok(message.startsWith(HEADER), message);
  assert.match(message, /\(eqeqeq\)/);
  assert.ok(message.includes(GUIDANCE), message);
  assert.match(message, /Counter recording failed:/);
}

/**
Exercise tracked counter accumulation from final results before feedback truncation.
*/
void test("edit cycles persist sorted rule counts and repeat later occurrences", () => {
  const root = fixture();
  const counter = path.join(root, "scripts/edit-hooks/diagnostics.json");
  const edited = path.join(root, "src/edited.js");
  const first = { session_id: "counter", tool_use_id: "first", cwd: root, tool_name: "Bash" };
  const second = { ...first, tool_use_id: "second" };
  const noEdit = { ...first, tool_use_id: "no-edit" };
  const counterOnly = {
    ...first,
    tool_use_id: "counter-only",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: scripts/edit-hooks/diagnostics.json\n*** End Patch" },
  };

  try {
    writeFileSync(counter, '{"z-last":2,"eqeqeq":3}\n');
    assert.equal(hook(root, "before", first), "");
    writeFileSync(
      edited,
      Array.from({ length: 25 }, (_, index) => `${String(index)} == "${String(index)}";`).join("\n") + "\n"
    );
    assertTruncatedFeedback(hookMessage(root, first));
    assert.equal(readFileSync(counter, "utf8"), '{\n  "eqeqeq": 28,\n  "z-last": 2\n}\n');

    assert.equal(hook(root, "before", second), "");
    writeFileSync(edited, 'const unused = 1;\n1 == "1";\n');
    assert.match(hookMessage(root, second), /\(no-unused-vars\)/);
    assert.equal(readFileSync(counter, "utf8"), '{\n  "eqeqeq": 29,\n  "no-unused-vars": 1,\n  "z-last": 2\n}\n');

    assert.equal(hook(root, "before", noEdit), "");
    assert.equal(hook(root, "after", noEdit), "");
    assert.equal(readFileSync(counter, "utf8"), '{\n  "eqeqeq": 29,\n  "no-unused-vars": 1,\n  "z-last": 2\n}\n');

    assert.equal(hook(root, "before", counterOnly), "");
    writeFileSync(counter, '{"eqeqeq":30}\n');
    assert.equal(hook(root, "after", counterOnly), "");
    assert.equal(readFileSync(counter, "utf8"), '{"eqeqeq":30}\n');
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
Exercise the named configuration switch without changing normal feedback.
*/
void test("disabled recording leaves the tracked file byte-for-byte unchanged", () => {
  const root = fixture(false);
  const counter = path.join(root, "scripts/edit-hooks/diagnostics.json");
  const event = { session_id: "disabled", tool_use_id: "first", cwd: root, tool_name: "Bash" };

  try {
    const original = '{"z-last":2,"eqeqeq":3}\n';

    writeFileSync(counter, original);
    assert.equal(hook(root, "before", event), "");
    writeFileSync(path.join(root, "src/edited.js"), '1 == "1";\n');
    assert.match(hookMessage(root, event), /\(eqeqeq\)/);
    assert.equal(readFileSync(counter, "utf8"), original);
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
Preserve lint feedback and existing bytes when the counter cannot be updated.
*/
void test("invalid or full counters keep normal lint feedback and remain untouched", () => {
  for (const original of ["{bad\n", '{"eqeqeq":-1}\n', '{"eqeqeq":9007199254740991}\n']) {
    const root = fixture();
    const counter = path.join(root, "scripts/edit-hooks/diagnostics.json");
    const event = { session_id: "counter-error", tool_use_id: "first", cwd: root, tool_name: "Bash" };

    try {
      writeFileSync(counter, original);
      assert.equal(hook(root, "before", event), "");
      writeFileSync(path.join(root, "src/edited.js"), '1== "1"\n');
      assertCounterFailureFeedback(root, event);
      assert.equal(readFileSync(counter, "utf8"), original);
      assertIdle(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/**
Keep arbitrary rule IDs separate from inherited object property names.
*/
void test("constructor rule ID accumulates as its own key", () => {
  const root = fixture();
  const counter = path.join(root, "scripts/edit-hooks/diagnostics.json");
  const event = { session_id: "special-rule", tool_use_id: "first", cwd: root, tool_name: "Bash" };

  try {
    assert.equal(hook(root, "before", event), "");
    writeFileSync(path.join(root, "src/edited.js"), '/* eslint constructor: "error" */\n1 == "1";\n');
    assert.match(hookMessage(root, event), /\(constructor\)/);
    assert.equal(readFileSync(counter, "utf8"), '{\n  "constructor": 1,\n  "eqeqeq": 1\n}\n');
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
