import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type PiState, readPiState } from "./pi-store";
import { type Config } from "./config";
import { type CodexRpc } from "./rpc";
import { type Data, string, object } from "../lib/protocol";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { localDirectory } from "./local-state";
import { loadHistory } from "./history";
import path from "node:path";
import { piModel, thinkingLevelSchema } from "./pi-models";
import { piResources } from "./pi-resources";
import { readFile } from "node:fs/promises";
import { taskDirectory } from "./task-archive";
import { writeLegacyTask } from "./task-legacy";
import { internalContext } from "./internal-context";
import { t as attempt } from "try";

/** Restore a Pi source or recreate only an empty, unflushed session pointer.
@param config - Exact parent identity and working directory.
@param saved - Durable projection when present.
@param directory - Private Pi session directory.
@returns Authoritative native session manager.
*/
async function sessionManager(config: Config, saved: PiState | null, directory: string) {
  if (saved) {
    const outcome = await attempt(async () => {
      await readFile(saved.sessionFile, "utf8");

      return SessionManager.open(saved.sessionFile);
    });

    if (outcome.ok) {
      return outcome.value;
    }

    const error = outcome.error;

    const hasPiHistory = saved.turns.some((turn) => turn.items.some((item) => item.source === "pi"));

    if (hasPiHistory || !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return SessionManager.create(config.cwd, directory);
}

/** Import complete original history once; never resume a still-active Codex parent in a new harness.
@param native - Native reader used exclusively for migration and delegate inspection.
@param config - Existing parent identity.
@param manager - Pi source receiving exact legacy context.
@returns Phone projection retaining native IDs and original content.
*/
async function migrate(native: CodexRpc, config: Config, manager: SessionManager): Promise<PiState> {
  const { thread } = await native.request("thread/read", { threadId: config.threadId, includeTurns: true });
  const turns = await loadHistory(native, thread);

  if (turns.some((turn) => turn.status === "inProgress")) {
    throw new Error("Finish the active Codex main turn before migrating this Pocket to Pi.");
  }

  const original = JSON.stringify({ source: "codex", thread, turns }, null, 2);
  const archive = path.join(taskDirectory(config.threadId), "legacy-codex.md");

  await writeLegacyTask(config.threadId, original);
  manager.appendCustomMessageEntry(
    "codex_migration",
    internalContext("codex_history_import", `Exact original conversation archive: ${archive}\n${original}`),
    false
  );

  return { sessionFile: manager.getSessionFile() ?? "", name: thread.name ?? "Pocket", turns };
}

/** Open a credential-isolated Pi session within the host process boundary, without claiming Codex sandbox enforcement.
@param config - Exact parent configuration.
@param native - Native reader for effective policy and legacy history.
@param params - Canonical model and effort overrides.
@param key - Central Settings key, held in memory only by Pi.
@param customTools - Host-owned compatibility tools, including structured phone questions.
@returns Pi session, source manager, model runtime and canonical projection.
*/
export async function openPiSession(
  config: Config,
  native: CodexRpc,
  params: Data,
  key: string | null,
  customTools: ToolDefinition[] = []
) {
  const { config: effective } = await native.request("config/read", { cwd: config.cwd, includeLayers: false });

  if (!key) {
    throw new Error("Add an OpenAI API key in Pocket Settings before starting the Pi main session.");
  }

  const agentDir = path.join(localDirectory(), "pi");
  const saved = await readPiState(config.threadId);
  const manager = await sessionManager(config, saved, path.join(agentDir, "sessions"));
  const state = saved ?? (await migrate(native, config, manager));

  for (const turn of state.turns) {
    // Earlier Pi projections stored the receipt only as the item ID. Restore the
    // canonical receipt field for delivery, attachments and internal notices.
    for (const item of turn.items) {
      if (item.source === "pi" && item.type === "userMessage") {
        item.clientId ??= item.id;
      }
    }

    if (turn.status !== "inProgress") {
      continue;
    }

    turn.status = "interrupted";
    turn.error = { message: "The host stopped during this Pi turn. Inspect saved context before continuing." };
  }

  if (saved && manager.getEntryCount() === 0) {
    manager.appendCustomMessageEntry(
      "codex_migration",
      internalContext("codex_history_import", JSON.stringify({ source: "codex", turns: saved.turns })),
      false
    );
  }

  state.sessionFile = manager.getSessionFile() ?? "";
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });

  await runtime.setRuntimeApiKey("openai", key);
  const selection = string(params.model) || "openai/gpt-6.1-sol";
  const effort = string(object(params.config).model_reasoning_effort) || "medium";
  const resourceLoader = await piResources(config, agentDir, string(params.developerInstructions) || undefined);
  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir,
    modelRuntime: runtime,
    model: piModel(runtime, selection),
    thinkingLevel: thinkingLevelSchema.parse(effort),
    sessionManager: manager,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(),
    customTools,
  });

  return {
    session,
    runtime,
    manager,
    state,
    selection,
    nativeDelegationProfile: {
      sandbox: string(effective.sandbox_mode),
      approvalPolicy: effective.approval_policy ?? null,
    },
  };
}
