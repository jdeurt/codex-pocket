import { GUIDANCE, HEADER, assertIdle, fixture, hook, hookMessage, run } from "./edit-hooks-fixture";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** Check sorted residual diagnostics and scoped writes.
@param message - Hook feedback.
@param src - Fixture source directory.
*/
function assertFirstFeedback(message: string, src: string): void {
  const lines = message.split("\n").filter((line) => line !== HEADER && line !== GUIDANCE);

  assert.ok(message.startsWith(HEADER), message);
  assert.ok(message.endsWith(GUIDANCE), message);
  assert.deepEqual(
    lines,
    [...new Set(lines)].toSorted((left, right) => left.localeCompare(right))
  );
  assert.match(message, /src\/edited\.js:1:\d+ .*\(no-unused-vars\)/);
  assert.match(message, /src\/created\.js:\d+:\d+ .*\(eqeqeq\)/);
  assert.doesNotMatch(message, /dirty\.js|ignored\.js|warning|error|stack trace/i);
  assert.equal(readFileSync(path.join(src, "dirty.js"), "utf8"), "const untouched= 3\n");
  assert.equal(readFileSync(path.join(src, "ignored.js"), "utf8"), "var ignored= 3\n");
  assert.equal(readFileSync(path.join(src, "edited.js"), "utf8"), "const revised = 1;\n");
}

/** Verify tracked and new edits are fixed without touching other dirty files.
@param root - Fixture checkout.
*/
function firstEdit(root: string): void {
  const src = path.join(root, "src");
  const event = { session_id: "fixture", tool_use_id: "first", cwd: root, tool_name: "apply_patch" };

  writeFileSync(path.join(src, "dirty.js"), "const untouched= 3\n");
  assert.equal(hook(root, "before", event), "");
  writeFileSync(path.join(src, "edited.js"), "var revised= 1\n");
  writeFileSync(path.join(src, "created.js"), 'const created= 2\n1 == "1"\n');
  writeFileSync(path.join(src, "ignored.js"), "var ignored= 3\n");
  assertFirstFeedback(hookMessage(root, event), src);
}

/** Check residual feedback when no formatter wrote a file.
@param message - Hook feedback.
*/
function assertSecondFeedback(message: string): void {
  assert.ok(message.startsWith("src/edited.js:1:"), message);
  assert.ok(message.endsWith(GUIDANCE), message);
  assert.ok(!message.includes(HEADER), message);
}

/** Verify diagnostics without a rewrite omit the optional header.
@param root - Fixture checkout.
*/
function secondEdit(root: string): void {
  const edited = path.join(root, "src/edited.js");
  const event = { session_id: "fixture", tool_use_id: "second", cwd: root, tool_name: "Bash" };

  assert.equal(hook(root, "before", event), "");
  writeFileSync(edited, "const second = 1;\n");
  assertSecondFeedback(hookMessage(root, event));
}

/** Check failure feedback and preservation of the original tool edit.
@param failure - Parser or formatter failure.
@param absent - Missing before snapshot feedback.
@param edited - File touched by the tool.
*/
function assertFailures(failure: string, absent: string, edited: string): void {
  assert.match(failure, /After-edit check could not run: Prettier could not format src\/edited\.js\./);
  assert.match(absent, /before-edit snapshot is unavailable/);
  assert.equal(readFileSync(edited, "utf8"), "const broken = ;\n");
}

/** Verify fixes alone are silent, while tool failures preserve the edit.
@param root - Fixture checkout.
*/
function finalEdits(root: string): void {
  const edited = path.join(root, "src/edited.js");
  const clean = {
    session_id: "fixture",
    tool_use_id: "third",
    cwd: root,
    tool_name: "mcp__fs__write",
    tool_input: { file_path: "src/edited.js" },
  };
  const broken = { ...clean, tool_use_id: "fourth" };
  const missing = { ...clean, tool_use_id: "missing" };

  assert.equal(hook(root, "before", clean), "");
  writeFileSync(edited, 'console.log("clean")\n');
  assert.equal(hook(root, "after", clean), "");
  assert.equal(readFileSync(edited, "utf8"), 'console.log("clean");\n');

  assert.equal(hook(root, "before", broken), "");
  writeFileSync(edited, "const broken = ;\n");
  assertFailures(hookMessage(root, broken), hookMessage(root, missing), edited);
  assertIdle(root);
}

/** Recover a dead runner owner and complete another real format/lint cycle.
@param root - Fixture checkout.
*/
function staleLockRecovery(root: string): void {
  const directory = path.join(run("git", ["rev-parse", "--absolute-git-dir"], root).trim(), "pocket-edit-hooks");
  const lock = path.join(directory, "runner.lock");
  const event = { session_id: "fixture", tool_use_id: "stale-lock", cwd: root, tool_name: "Bash" };

  assert.equal(hook(root, "before", event), "");
  writeFileSync(path.join(root, "src/edited.js"), 'console.log("recovered")\n');
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), "99999999");
  assert.equal(hook(root, "after", event), "");
  assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), 'console.log("recovered");\n');
  assertIdle(root);
}

/** Report an ESLint config failure while preserving the edit.
@param root - Fixture checkout.
*/
function configFailure(root: string): void {
  const edited = path.join(root, "src/edited.js");
  const config = path.join(root, "eslint.config.mjs");
  const event = {
    session_id: "fixture",
    tool_use_id: "bad-config",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/edited.js\n*** End Patch" },
  };

  assert.equal(hook(root, "before", event), "");
  writeFileSync(edited, "var preserved= 1\n");
  writeFileSync(config, "export default [invalid syntax\n");
  assert.match(hookMessage(root, event), /repository-local ESLint could not check edited files/);
  assert.equal(readFileSync(edited, "utf8"), "var preserved= 1\n");
  assert.equal(readFileSync(config, "utf8"), "export default [invalid syntax\n");
  assertIdle(root);
}

void test("informational native edit hooks format only tool-touched files and preserve edits", () => {
  const root = fixture();

  try {
    firstEdit(root);
    secondEdit(root);
    finalEdits(root);
    staleLockRecovery(root);
    configFailure(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("ignored JavaScript and hardlinks outside the checkout are never rewritten", () => {
  const root = fixture();
  const external = mkdtempSync(path.join(os.tmpdir(), "pocket-edit-hooks-external-"));

  try {
    const event = { session_id: "scope", tool_use_id: "one", cwd: root, tool_name: "Bash" };
    const ignored = path.join(root, "dist/ignored.js");
    const linked = path.join(root, "src/linked.js");
    const outside = path.join(external, "outside.js");

    mkdirSync(path.dirname(ignored));
    writeFileSync(outside, "var outside= 1\n");
    assert.equal(hook(root, "before", event), "");
    writeFileSync(ignored, "var ignored= 2\n");
    linkSync(outside, linked);
    assert.equal(hook(root, "after", event), "");
    assert.equal(readFileSync(ignored, "utf8"), "var ignored= 2\n");
    assert.equal(readFileSync(linked, "utf8"), "var outside= 1\n");
    assert.equal(readFileSync(outside, "utf8"), "var outside= 1\n");
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

void test("native interruption clears only that turn's bookkeeping before another edit", () => {
  const root = fixture();

  try {
    const interrupted = {
      session_id: "interrupted-session",
      turn_id: "interrupted-turn",
      tool_use_id: "first",
      cwd: root,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/edited.js\n*** End Patch" },
    };
    const other = {
      ...interrupted,
      session_id: "other-session",
      turn_id: "other-turn",
      tool_use_id: "second",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/dirty.js\n*** End Patch" },
    };
    const directory = path.join(run("git", ["rev-parse", "--absolute-git-dir"], root).trim(), "pocket-edit-hooks");

    assert.equal(hook(root, "before", interrupted), "");
    assert.equal(hook(root, "before", other), "");
    assert.equal(
      hook(root, "before", {
        session_id: interrupted.session_id,
        turn_id: interrupted.turn_id,
        cwd: root,
        hook_event_name: "Interrupt",
      }),
      ""
    );
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(hook(root, "after", other), "");

    {
      const resumed = { ...interrupted, turn_id: "next-turn", tool_use_id: "resumed" };

      assert.equal(hook(root, "before", resumed), "");
      writeFileSync(path.join(root, "src/edited.js"), "var resumed= 1\n");
      assert.match(hookMessage(root, resumed), /resumed.*\(no-unused-vars\)/);
    }
    assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "const resumed = 1;\n");
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
