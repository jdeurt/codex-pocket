import {
  HEADER,
  type HookEvent,
  SOURCE,
  assertIdle,
  fixture,
  hookAsync,
  informationalMessage,
  run,
} from "./edit-hooks-fixture";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import test from "node:test";

const MARKER_POLL_MS = 20;
const MARKER_POLL_ATTEMPTS = 100;

void test("parallel disjoint edits retain per-tool feedback and leave unrelated dirt untouched", async () => {
  const root = fixture();

  try {
    const first = {
      session_id: "session-a",
      tool_use_id: "same-tool-id",
      cwd: root,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: src/parallel-a.js\n+var alpha= 1\n*** End Patch" },
    };
    const second = {
      ...first,
      session_id: "session-b",
      tool_input: { command: "*** Begin Patch\n*** Add File: src/parallel-b.js\n+var beta= 2\n*** End Patch" },
    };

    writeFileSync(path.join(root, "src/dirty.js"), "const untouched= 3\n");
    assert.deepEqual(await Promise.all([hookAsync(root, "before", first), hookAsync(root, "before", second)]), [
      "",
      "",
    ]);
    {
      const directory = path.join(run("git", ["rev-parse", "--absolute-git-dir"], root).trim(), "pocket-edit-hooks");
      const states = readdirSync(directory).map((name) => readFileSync(path.join(directory, name), "utf8"));

      assert.ok(
        states.some((state) => state.includes('"targets":["src/parallel-a.js"]')),
        JSON.stringify(states)
      );
      assert.ok(
        states.some((state) => state.includes('"targets":["src/parallel-b.js"]')),
        JSON.stringify(states)
      );
    }

    writeFileSync(path.join(root, "src/parallel-a.js"), "var alpha= 1\n");
    writeFileSync(path.join(root, "src/parallel-b.js"), "var beta= 2\n");

    {
      const [firstOutput, secondOutput] = await Promise.all([
        hookAsync(root, "after", first),
        hookAsync(root, "after", second),
      ]);
      const firstMessage = informationalMessage(firstOutput);
      const secondMessage = informationalMessage(secondOutput);

      assert.match(firstMessage, /parallel-a\.js:1:\d+ .*alpha.*\(no-unused-vars\)/);
      assert.doesNotMatch(firstMessage, /parallel-b\.js|beta/);
      assert.match(secondMessage, /parallel-b\.js:1:\d+ .*beta.*\(no-unused-vars\)/);
      assert.doesNotMatch(secondMessage, /parallel-a\.js|alpha/);
      assert.ok(firstMessage.startsWith(HEADER));
      assert.ok(secondMessage.startsWith(HEADER));
    }
    assert.equal(readFileSync(path.join(root, "src/parallel-a.js"), "utf8"), "const alpha = 1;\n");
    assert.equal(readFileSync(path.join(root, "src/parallel-b.js"), "utf8"), "const beta = 2;\n");
    assert.equal(readFileSync(path.join(root, "src/dirty.js"), "utf8"), "const untouched= 3\n");
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("overlapping same-file claims skip rewrites and recover on the next edit", async () => {
  const root = fixture();

  try {
    const first = {
      session_id: "session-a",
      tool_use_id: "first",
      cwd: root,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/edited.js\n*** End Patch" },
    };
    const second = { ...first, session_id: "session-b", tool_use_id: "second" };

    await Promise.all([hookAsync(root, "before", first), hookAsync(root, "before", second)]);
    writeFileSync(path.join(root, "src/edited.js"), "var first= 1\n");
    assert.match(informationalMessage(await hookAsync(root, "after", first)), /overlapping edits/);
    assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "var first= 1\n");
    writeFileSync(path.join(root, "src/edited.js"), "var second= 2\n");
    assert.match(informationalMessage(await hookAsync(root, "after", second)), /overlapping edits/);
    assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "var second= 2\n");
    assertIdle(root);

    {
      const recovery = { ...first, session_id: "session-c", tool_use_id: "recovery" };

      await hookAsync(root, "before", recovery);
      writeFileSync(path.join(root, "src/edited.js"), "var recovered= 3\n");
      assert.match(informationalMessage(await hookAsync(root, "after", recovery)), /recovered.*\(no-unused-vars\)/);
    }
    assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "const recovered = 3;\n");
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("identical tool identities in distinct worktrees retain isolated state and diagnostics", async () => {
  const root = fixture();
  const other = `${root}-linked`;

  try {
    const event = {
      session_id: "same-session",
      tool_use_id: "same-tool",
      cwd: root,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/edited.js\n*** End Patch" },
    };
    const linkedEvent = { ...event, cwd: other };

    run("git", ["worktree", "add", "-q", "-b", "linked", other], root);
    symlinkSync(path.join(SOURCE, "node_modules"), path.join(other, "node_modules"), "dir");

    await Promise.all([hookAsync(root, "before", event), hookAsync(other, "before", linkedEvent)]);
    writeFileSync(path.join(root, "src/edited.js"), "var primary= 1\n");
    writeFileSync(path.join(other, "src/edited.js"), "var linked= 2\n");
    {
      const [primaryOutput, linkedOutput] = await Promise.all([
        hookAsync(root, "after", event),
        hookAsync(other, "after", linkedEvent),
      ]);

      assert.match(informationalMessage(primaryOutput), /primary.*\(no-unused-vars\)/);
      assert.doesNotMatch(primaryOutput, /linked/);
      assert.match(informationalMessage(linkedOutput), /linked.*\(no-unused-vars\)/);
      assert.doesNotMatch(linkedOutput, /primary/);
    }
    assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "const primary = 1;\n");
    assert.equal(readFileSync(path.join(other, "src/edited.js"), "utf8"), "const linked = 2;\n");
    assertIdle(root);
    assertIdle(other);
  } finally {
    if (existsSync(path.join(other, ".git"))) {
      run("git", ["worktree", "remove", "--force", other], root);
    }

    rmSync(root, { recursive: true, force: true });
  }
});

void test("a live runner lock times out without rewriting the tool edit or leaving its snapshot", async () => {
  const root = fixture();

  try {
    const event = {
      session_id: "contended",
      tool_use_id: "first",
      cwd: root,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/edited.js\n*** End Patch" },
    };
    const directory = path.join(run("git", ["rev-parse", "--absolute-git-dir"], root).trim(), "pocket-edit-hooks");
    const lock = path.join(directory, "runner.lock");

    await hookAsync(root, "before", event);
    writeFileSync(path.join(root, "src/edited.js"), "var retained= 1\n");
    mkdirSync(lock);
    writeFileSync(path.join(lock, "owner"), String(process.pid));
    assert.match(
      informationalMessage(await hookAsync(root, "after", event)),
      /another after-edit check is still running/
    );
    assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "var retained= 1\n");
    assert.deepEqual(readdirSync(directory), ["runner.lock"]);
    rmSync(lock, { recursive: true, force: true });
    assertIdle(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Hold the runner lock while both native bookkeeping events start.
@param root - Disposable worktree.
@param directory - Private Git state directory.
@param lock - Runner lock path.
@param event - Pending tool call.
@returns Concurrent hook process results.
*/
function startInterleaving(
  root: string,
  directory: string,
  lock: string,
  event: HookEvent
): [Promise<string>, Promise<string>] {
  const interruption: HookEvent = {
    session_id: event.session_id,
    turn_id: event.turn_id,
    cwd: root,
    hook_event_name: "Interrupt",
  };

  mkdirSync(directory, { recursive: true });
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), String(process.pid));

  return [hookAsync(root, "before", event), hookAsync(root, "before", interruption)];
}

/** Wait until interruption is recorded before releasing the runner lock.
@param directory - Private Git state directory.
*/
async function waitForInterruption(directory: string): Promise<void> {
  for (let attempt = 0; attempt < MARKER_POLL_ATTEMPTS; attempt += 1) {
    if (readdirSync(directory).some((name) => name.endsWith(".interrupted"))) {
      return;
    }

    await delay(MARKER_POLL_MS);
  }

  assert.fail("native interruption marker was not written");
}

/** Exercise an interrupted before-tool snapshot and a later real edit.
@param root - Disposable worktree.
@param directory - Private Git state directory.
@param lock - Runner lock path.
*/
async function runInterruptedInterleaving(root: string, directory: string, lock: string): Promise<void> {
  const event: HookEvent = {
    session_id: "interleaved-session",
    turn_id: "interleaved-turn",
    tool_use_id: "pending",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/edited.js\n*** End Patch" },
  };
  const resumed: HookEvent = { ...event, turn_id: "resumed-turn", tool_use_id: "resumed" };
  const [before, interrupted] = startInterleaving(root, directory, lock, event);

  await waitForInterruption(directory);
  rmSync(lock, { recursive: true, force: true });
  assert.deepEqual(await Promise.all([before, interrupted]), ["", ""]);
  assertIdle(root);

  await hookAsync(root, "before", resumed);
  writeFileSync(path.join(root, "src/edited.js"), "var resumed= 1\n");
  assert.match(informationalMessage(await hookAsync(root, "after", resumed)), /resumed.*\(no-unused-vars\)/);
  assert.equal(readFileSync(path.join(root, "src/edited.js"), "utf8"), "const resumed = 1;\n");
  assertIdle(root);
}

void test("interruption before a pending snapshot commit cannot leave an orphaned claim", async () => {
  const root = fixture();
  const directory = path.join(run("git", ["rev-parse", "--absolute-git-dir"], root).trim(), "pocket-edit-hooks");
  const lock = path.join(directory, "runner.lock");

  try {
    await runInterruptedInterleaving(root, directory, lock);
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
