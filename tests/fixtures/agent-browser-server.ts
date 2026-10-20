// Isolated OFFLINE REPLAY server. No real harness session or credentials are used.
import { claudeSession, replayImage, replayParent } from "./agent-browser-data";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { AGENT_ORIGIN } from "./browser-defaults";
import { DelegationStore } from "../../src/server/delegations";
import path from "node:path";
import { runNextFixture } from "./next-server";

/**
Reset this replay's private data and configure its fake protocol paths.
@returns The repository-local directory containing only synthetic replay state.
*/
async function prepareReplay() {
  const directory = path.resolve(".local/agent-browser-replay");

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "state");
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, "claude");
  process.env.POCKET_REPLAY_DIRECTORY = directory;
  await writeFile(path.join(directory, "control.json"), JSON.stringify({ stage: "initial" }));
  await writeFile(path.join(directory, "rpc.jsonl"), "");
  await writeFile(path.join(directory, "child-image.png"), Buffer.from(replayImage.split(",", 2)[1], "base64"));

  return directory;
}

const directory = await prepareReplay();
const store = new DelegationStore(path.join(directory, "state"));
const policy = { sandbox: "danger-full-access", approval: "never", model: "gpt-replay", effort: "high" };
const ids: Record<string, string> = {};
const projectKey = process.cwd().replaceAll(/[^a-zA-Z0-9]/g, "-");
const project = path.join(directory, "claude", "projects", projectKey);

/**
Create a synthetic child with no dispatchable command left in its queue.
@param name - Stable fixture title used by browser assertions and saved identifiers.
@param session - Fake saved-session identifier, or undefined for an empty child.
@param status - Lifecycle state displayed by the agent browser.
@param [harness] - Saved-history protocol associated with this synthetic child.
@returns The created child with its fixture harness selection.
*/
function pocket(
  name: string,
  session: string | undefined,
  status: "running" | "waiting" | "idle" | "closed",
  harness: "codex" | "claude" = "codex"
) {
  // Create using the public store, then finish the synthetic command before setting
  // the replay lifecycle state so the real worker never dispatches replay work.
  const child = store.create(replayParent, {
    title: name,
    body: "Offline replay fixture",
    harness: "codex",
    idempotencyKey: name,
  });
  const command = store.claim(replayParent, child.id);

  if (!command) {
    throw new Error("Replay fixture command was not created.");
  }

  store.finish(command, "completed", "offline fixture");

  if (session) {
    store.setSession(replayParent, child.id, session);
  }

  store.setStatus(replayParent, child.id, status);
  ids[name] = child.id;

  return { ...child, harness };
}

/**
Seed the Codex child, its native descendant and its informational request.
*/
function seedCodex() {
  const codex = pocket("Codex Side Pocket", "side-codex", "waiting");

  store.metadata(replayParent, codex.id, {
    nativeAgents: {
      "side-native": { parentId: "side-codex", name: "Codex native inside Side Pocket", status: "running" },
    },
  });
  store.mail.request(replayParent, codex.id, {
    id: "child-request",
    method: "item/commandExecution/requestApproval",
    kind: "approval",
    input: { reason: "Replay child wants approval. This is informative only.", command: "NEVER_EXECUTE_CHILD_ACTION" },
  });
}

/**
Seed Claude saved-history metadata without invoking a Claude executable.
*/
async function seedClaude() {
  const claude = pocket("Claude Side Pocket", claudeSession, "running", "claude");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(directory, "state", "delegations.sqlite"));

  try {
    db.prepare("UPDATE side_pockets SET harness='claude' WHERE id=?").run(claude.id);
    store.metadata(replayParent, claude.id, {
      model: "claude-replay",
      effort: "high",
      nativeAgents: {
        "a-replay": { name: "Claude native research", status: "running" },
        "a-nested": { name: "Claude nested analysis", status: "completed", parentId: "a-replay" },
      },
    });
  } finally {
    db.close();
  }
}

/**
Create an unrelated parent's child for scope-denial assertions.
@returns The private child that must remain absent from the active parent's catalog.
*/
function createPrivateChild() {
  store.saveParent("unrelated-parent", { cwd: process.cwd(), policy });

  return store.create("unrelated-parent", {
    title: "PRIVATE_OTHER_POCKET",
    body: "Private fixture",
    idempotencyKey: "private",
  });
}

/**
Record the unrelated child's identifier after the main hierarchy exists.
*/
function savePrivateChild() {
  const unrelated = createPrivateChild();

  ids.private = unrelated.id;
}

/**
Build the saved child hierarchy and retain identifiers used by browser assertions.
*/
async function seedPockets() {
  try {
    store.saveParent(replayParent, { cwd: process.cwd(), policy });
    seedCodex();
    pocket("Closed Side Pocket", "closed-session", "closed");
    pocket("Empty Side Pocket", undefined, "idle");
    pocket("Unavailable history", "missing-session", "closed");
    await seedClaude();
    savePrivateChild();
    await writeFile(path.join(directory, "ids.json"), JSON.stringify(ids));
  } finally {
    store.close();
  }
}

/**
Describe one synthetic Claude saved transcript, including native-agent ancestry.
@param [agentId] - Transcript owner, defaulting to the main Claude fixture.
@param [parentAgent] - Native parent identifier when this is a nested transcript.
@returns Saved JSONL records understood by the actual Claude history reader.
*/
function messages(agentId = "claude-main", parentAgent = "") {
  const prefix = agentId;

  return [
    {
      type: "user",
      uuid: `${prefix}-u`,
      parentUuid: undefined,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Read all saved messages." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: replayImage.split(",", 2)[1] } },
        ],
      },
    },
    {
      type: "assistant",
      uuid: `${prefix}-a1`,
      parentUuid: `${prefix}-u`,
      message: {
        role: "assistant",
        model: "claude-replay",
        content: [
          { type: "text", text: "Claude earlier progress." },
          { type: "tool_use", id: `${prefix}-tool`, name: "Read", input: { file_path: "/fixture.txt" } },
        ],
        stop_reason: "tool_use",
      },
    },
    {
      type: "user",
      uuid: `${prefix}-result`,
      parentUuid: `${prefix}-a1`,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `${prefix}-tool`, content: "CLAUDE_REPLAY_TOOL_OUTPUT" }],
      },
    },
    {
      type: "assistant",
      uuid: `${prefix}-a2`,
      parentUuid: `${prefix}-result`,
      message: {
        role: "assistant",
        model: "claude-replay",
        content: [{ type: "text", text: `**Claude saved transcript ${prefix}**` }],
        stop_reason: agentId === "a-replay" ? "tool_use" : "end_turn",
      },
    },
  ].map((message) => ({
    ...message,
    sessionId: claudeSession,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    ...(agentId !== "claude-main" && { agentId, isSidechain: true, parentAgentId: parentAgent || undefined }),
  }));
}

await seedPockets();
await mkdir(path.join(project, claudeSession, "subagents"), { recursive: true });
await writeFile(
  path.join(project, `${claudeSession}.jsonl`),
  messages()
    .map((message) => JSON.stringify(message))
    .join("\n") + "\n"
);

for (const [id, parent] of [
  ["a-replay", undefined],
  ["a-nested", "a-replay"],
] as const) {
  await writeFile(
    path.join(project, claudeSession, "subagents", `agent-${id}.jsonl`),
    messages(id, parent)
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n"
  );
}

await runNextFixture("agents", AGENT_ORIGIN, {
  CODEX_THREAD_ID: replayParent,
  CODEX_CWD: process.cwd(),
  CODEX_BINARY: process.execPath,
  CODEX_SERVER_ARGS: JSON.stringify([
    "--import",
    path.resolve("node_modules/tsx/dist/loader.mjs"),
    path.resolve("tests/fixtures/agent-browser-rpc.ts"),
  ]),
  CODEX_ALLOWED_ORIGINS: AGENT_ORIGIN,
});
