import { DefaultResourceLoader, createMcpExtension } from "@earendil-works/pi-coding-agent";
import { type Config } from "./config";
import { MAIN_INSTRUCTIONS } from "./pocket-prompts";
import { localDirectory } from "./local-state";
import path from "node:path";
import { taskDirectory } from "./task-archive";

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
    loadConfig: () => ({
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
              POCKET_CODEX_BINARY: config.codexBinary,
              POCKET_CODEX_SERVER_ARGS: JSON.stringify(config.serverArgs),
              POCKET_ID: config.pocketId ?? "main",
              POCKET_SERVER_ORIGIN:
                config.allowedOrigins.find((origin) => ["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) ??
                config.allowedOrigins[0],
            },
          },
        },
      ],
    }),
  });
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    // Project executable extensions require an explicit host trust interface before loading.
    noExtensions: true,
    extensionFactories: [mcp],
    appendSystemPrompt: [
      instructions,
      `Exact task archives for this Pocket are in ${taskDirectory(config.threadId)}. ` +
        "Use mcp__pocket__pocket_task_search to locate prior work, then read the Markdown file directly.",
    ],
  });

  await loader.reload();

  return loader;
}
