import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { type StorageValue } from "zustand/middleware";
import { createDraftStore, type DraftData } from "../../src/state/draft";
import { createSavedVoiceStore, savedVoiceSchema } from "../../src/state/saved-voice";
import { createThreadStore, stageMessage, publishThread } from "../../src/state/thread";
import { createVoiceStore, mergeCaptions } from "../../src/state/voice";
import { initialSnapshot } from "../../src/lib/protocol";
import { type VoiceSegment } from "../../src/lib/voice-history";
import { sqliteStorage } from "../../src/server/zustand-storage";
import { VoiceHistory } from "../../src/server/voice-history";
import { writeLocal } from "../../src/server/local-state";
import { workspace } from "../fixtures/workflow";

const caption: VoiceSegment = {
  id: "realtime:call:item:user",
  itemId: "item",
  nativeSessionId: "call",
  role: "user",
  text: "Keep this context.",
  done: true,
  afterItemId: null,
};

await test("Zustand stores isolate requests and reconcile optimistic messages without duplicate rows", () => {
  const first = createThreadStore({ ...initialSnapshot, threadId: "first" });
  const second = createThreadStore({ ...initialSnapshot, threadId: "second" });

  stageMessage(first, "receipt", "Keep my message.");
  assert.equal(second.getState().state.queue.length, 0);
  assert.equal(first.getState().state.queue.length, 1);
  publishThread(
    first,
    {
      ...initialSnapshot,
      threadId: "first",
      connection: "connected",
      turns: [
        {
          id: "turn",
          status: "completed",
          items: [
            {
              id: "native",
              clientId: "receipt",
              type: "userMessage",
              content: [{ type: "text", text: "Keep my message." }],
            },
          ],
        },
      ],
    },
    true
  );
  assert.equal(first.getState().pending.length, 0);
  assert.equal(first.getState().state.queue.length, 0);
  assert.equal(first.getState().state.turns[0].items.length, 1);
  assert.equal(second.getState().state.threadId, "second");

  const voice = createVoiceStore([caption]);

  mergeCaptions(voice, [{ ...caption, done: false, text: "Keep" }]);
  assert.deepEqual(voice.getState().segments, [caption]);
});

await test("Zustand manual hydration keeps SSR deterministic and preserves edits made during delayed storage reads", async () => {
  const pending = Promise.withResolvers<StorageValue<DraftData> | null>();
  const writes: DraftData[] = [];

  let reads = 0;

  const store = createDraftStore("first", {
    getItem: () => {
      reads++;

      return pending.promise;
    },
    setItem: (_key, value) => {
      writes.push(value.state);
    },
    removeItem: () => assert.fail("Hydration must not remove saved state."),
  });

  assert.equal(reads, 0);
  assert.equal(store.getInitialState().text, "");
  const hydration = store.persist.rehydrate();

  store.getState().edit("New typing while storage is loading.");
  pending.resolve({ state: { text: "Older saved draft." }, version: 1 });
  await hydration;
  assert.equal(store.getState().text, "New typing while storage is loading.");
  assert.deepEqual(writes, [{ text: "New typing while storage is loading." }]);
  assert.equal(store.persist.hasHydrated(), true);
  const empty = createDraftStore("empty", {
    getItem: () => null,
    setItem: () => assert.fail("Reading empty storage must not write state."),
    removeItem: () => assert.fail("Hydration must not remove saved state."),
  });

  await empty.persist.rehydrate();
  assert.equal(empty.persist.hasHydrated(), true);
  assert.equal(empty.getState().text, "");
});

await test("Zustand SQLite hydration survives reopening and keeps conversation keys isolated", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-state-"));

  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "state.sqlite");
  const first = createSavedVoiceStore("first", sqliteStorage(filename, savedVoiceSchema));

  await first.hydrate();
  first.store.setState({ segments: [caption] });
  const reopened = createSavedVoiceStore("first", sqliteStorage(filename, savedVoiceSchema));
  const other = createSavedVoiceStore("other", sqliteStorage(filename, savedVoiceSchema));

  assert.deepEqual(reopened.store.getInitialState().segments, []);
  await reopened.hydrate();
  await other.hydrate();
  assert.deepEqual(reopened.store.getState().segments, [caption]);
  assert.deepEqual(other.store.getState().segments, []);
});

await test("Zustand voice history restores legacy JSON and persists new captions in SQLite without modifying legacy files", async (t) => {
  await workspace(t);
  const thread = "legacy-thread";
  const key = createHash("sha256").update(thread).digest("hex");
  const filename = `voice-history/${key}.json`;

  await writeLocal(filename, [caption]);
  const history = new VoiceHistory(thread);

  assert.deepEqual(await history.read(), [caption]);
  await history.finalize({ item_id: "reply", transcript: "Got it." }, "call", "assistant", caption.id);
  const reopened = await new VoiceHistory(thread).read();

  assert.equal(reopened.length, 2);
  assert.equal(reopened[1].text, "Got it.");
  const legacy = await readFile(path.join(process.env.CODEX_POCKET_STATE_DIR ?? "", filename), "utf8");

  assert.deepEqual(JSON.parse(legacy), [caption]);
});

await test("Zustand voice hydration rejects incompatible persisted versions without replacing saved data", async () => {
  let writes = 0;

  const history = createSavedVoiceStore("future", {
    getItem: () => ({ state: { segments: [caption] }, version: 99 }),
    setItem: () => {
      writes++;
    },
    removeItem: () => assert.fail("Hydration must not remove saved state."),
  });

  await assert.rejects(history.hydrate(), /could not be restored/);
  assert.equal(writes, 0);
});
