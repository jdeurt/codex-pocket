import { usageReport } from "../src/server/usage-report";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    start: { type: "string" },
    end: { type: "string" },
    day: { type: "string" },
    timezone: { type: "string", default: Intl.DateTimeFormat().resolvedOptions().timeZone },
    format: { type: "string", default: "json" },
    "codex-dir": { type: "string" },
    "claude-dir": { type: "string" },
  },
});

/**
Validate a report window before reading native local records.
@returns The explicit interval or validated IANA local-day selector.
*/
function reportWindow() {
  const timezone = values.timezone;
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  if (values.day) {
    if (
      values.start ||
      values.end ||
      !/^\d{4}-\d{2}-\d{2}$/.test(values.day) ||
      !Number.isFinite(Date.parse(values.day))
    ) {
      throw new Error("Use --day YYYY-MM-DD alone, or --start/--end with explicit offsets.");
    }
    return { day: values.day, timezone };
  }
  if (
    !values.start ||
    !values.end ||
    !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(values.start) ||
    !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(values.end) ||
    !(Date.parse(values.start) < Date.parse(values.end))
  ) {
    throw new Error("Supply --start ISO --end ISO (with offsets), or --day YYYY-MM-DD --timezone IANA.");
  }
  return { start: values.start, end: values.end, timezone };
}

/**
Print a compact Markdown export without confusing missing billing data with zero cost.
@param report - Collected native local usage and provenance.
@returns Human-readable per-chat/model table and coverage notes.
*/
function markdown(report: Awaited<ReturnType<typeof usageReport>>) {
  return [
    "# Pocket usage",
    "",
    `Window: ${JSON.stringify(report.window)}`,
    "",
    "| Harness | Chat | Parent | Model | Token categories | Reported USD |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.chats.map(
      (chat) =>
        `| ${chat.harness} | ${chat.sessionId} | ${chat.parentId ?? "unknown"} | ${chat.model} | ${JSON.stringify(chat.categories)} | ${chat.cost.reportedUSD ?? "unknown"} |`
    ),
    "",
    ...Object.values(report.coverage).map((value) => (typeof value === "string" ? value : JSON.stringify(value))),
    "",
    `Subset rules: ${JSON.stringify(report.subsets)}`,
    "",
  ].join("\n");
}

const report = await usageReport(reportWindow(), {
  codex: values["codex-dir"] ?? path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "sessions"),
  claude:
    values["claude-dir"] ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects"),
});
if (!["json", "markdown"].includes(values.format)) {
  throw new Error("Format must be json or markdown.");
}
console.info(values.format === "markdown" ? markdown(report) : JSON.stringify(report, null, 2));
