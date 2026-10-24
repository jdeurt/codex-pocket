import { t as captureResult } from "try";
import { calibrationReply, claudeConformance, codexConformance } from "../tests/simulators/conformance";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { CodexRpc } from "../src/server/rpc";
import { configSchema } from "../src/server/config";
import { controlledClaude } from "../tests/simulators/launch";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "pocket-native-conformance-"));
const rpc = new CodexRpc();
const codexBinary = process.env.POCKET_CALIBRATE_CODEX ?? "codex";
const claudeBinary = process.env.POCKET_CALIBRATE_CLAUDE ?? "claude";
const claude = controlledClaude({
  cwd: root,
  pathToClaudeCodeExecutable: claudeBinary,
  tools: [],
  strictMcpConfig: true,
  mcpServers: {},
  settingSources: [],
  persistSession: false,
  model: "haiku",
  maxTurns: 1,
});
const report = {
  codexVersion: execFileSync(codexBinary, ["--version"], { encoding: "utf8" }).trim(),
  claudeVersion: execFileSync(claudeBinary, ["--version"], { encoding: "utf8" }).trim(),
  expectedReply: calibrationReply,
  codex: { passed: [] as string[] },
  claude: { passed: [] as string[] },
};

/**
Run native behavioral probes without storing account metadata or transcripts.
*/
async function calibrate() {
  await rpc.connect(configSchema.parse({ cwd: root, threadId: "calibration", codexBinary }), "bare");
  report.codex = await codexConformance(rpc, root, process.env.POCKET_CALIBRATE_MODEL ?? "gpt-6.1-sol");
  report.claude = await claudeConformance(claude.run, "haiku", claude.release);
  await writeFile(
    new URL("../.local/simulator-calibration.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify(report));
}

const completed = await captureResult(calibrate);

await rpc.shutdown();
claude.close();
await rm(root, { recursive: true, force: true });

if (!completed.ok) {
  throw completed.error;
}
