import { assertIdle, fixture, hook, hookMessage } from "./edit-hooks-fixture";
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
Exercise malformed input preservation through a real hook cycle.
*/
void test("malformed tracked JSON produces informational failure and remains untouched", () => {
  const root = fixture();
  const counter = path.join(root, "scripts/edit-hooks/diagnostics.json");
  const event = { session_id: "malformed", tool_use_id: "first", cwd: root, tool_name: "Bash" };

  try {
    const original = "{bad\n";

    writeFileSync(counter, original);
    assert.equal(hook(root, "before", event), "");
    writeFileSync(path.join(root, "src/edited.js"), '1 == "1";\n');
    assert.match(hookMessage(root, event), /diagnostics counter could not be read; existing counts were preserved/);
    assert.equal(readFileSync(counter, "utf8"), original);
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
