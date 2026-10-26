import { taskContextExtension } from "../tasks/context-extension";
import { taskProvenanceExtension } from "../tasks/command-provenance";
import { localOrigin } from "../state/native-config";
import { DefaultResourceLoader, createMcpExtension, type LoadedMcpConfig } from "@earendil-works/pi-coding-agent";
import { type Config } from "./config";
import { MAIN_INSTRUCTIONS } from "./pocket-prompts";
import { localDirectory } from "./local-state";
import path from "node:path";
import { taskDirectory } from "../tasks/archive";
import { costAccountingExtension } from "./cost-extension";

/** Read the host's narrowly scoped native MCP environment.
@param config - Validated parent configuration.
@param root - Explicit application directory.
@returns Native MCP resource configuration.
*/
function pocketMcpConfig(config: Config, root: string): LoadedMcpConfig {
  return {
    errors: [],
    servers: [
      {
        name: "pocket",
        source: "Pocket host",
        scope: "extension",
        config: {
          command: process.execPath,
          args: ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "scripts/mcp.ts")],
          cwd: root,
          exposure: "direct",
          env: {
            CODEX_POCKET_STATE_DIR: localDirectory(),
            POCKET_THREAD_ID: config.threadId,
            POCKET_MAIN_THREAD_ID: config.threadId,
            POCKET_QMD_EMBED_MODEL: process.env.POCKET_QMD_EMBED_MODEL ?? "",
            POCKET_QMD_RERANK_MODEL: process.env.POCKET_QMD_RERANK_MODEL ?? "",
            POCKET_CODEX_BINARY: config.codexBinary,
            POCKET_CODEX_SERVER_ARGS: JSON.stringify(config.serverArgs),
            POCKET_ID: config.pocketId ?? "main",
            POCKET_SERVER_ORIGIN: localOrigin(config.allowedOrigins),
          },
        },
      },
    ],
  };
}

/** Load Pi's native tools/resources and connect the complete existing Pocket MCP surface.
@param config - Exact parent identity and host-owned native delegation settings.
@param agentDir - Private Pi runtime directory, separate from global credentials.
@param instructions - Effective native developer instructions composed with Pocket's main contract.
@returns Loaded resource owner ready for createAgentSession.
*/
export async function piResources(config: Config, agentDir: string, instructions = MAIN_INSTRUCTIONS) {
  const root = process.cwd();
  const mcp = createMcpExtension({
    logPath: path.join(agentDir, "mcp.log"),
    loadConfig: pocketMcpConfig.bind(undefined, config, root),
  });
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    // Project executable extensions require an explicit host trust interface before loading.
    noExtensions: true,
    extensionFactories: [
      mcp,
      costAccountingExtension.bind(undefined, config.threadId),
      taskProvenanceExtension.bind(undefined, config.threadId),
      taskContextExtension.bind(undefined, config.threadId),
    ],
    appendSystemPrompt: [
      instructions,
      `Exact task archives for this Pocket are in ${taskDirectory(config.threadId)}. ` +
        "Use mcp__pocket__pocket_task_search to locate prior work, then read the Markdown file directly.",
    ],
  });

  await loader.reload();

  return loader;
}
