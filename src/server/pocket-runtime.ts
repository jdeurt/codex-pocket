import { type Thread, string } from "../lib/protocol";
import type { CodexRpc } from "./rpc";
import type { Config } from "./config";
import { localDirectory } from "./local-state";
import path from "node:path";

export function pocketServerArgs(config: Config) {
  const root = process.cwd();
  const overrides: Record<string, unknown> = {
    "mcp_servers.pocket.command": process.execPath,
    "mcp_servers.pocket.args": [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "scripts/mcp.ts"),
    ],
    "mcp_servers.pocket.cwd": root,
    "mcp_servers.pocket.default_tools_approval_mode": "approve",
    "mcp_servers.pocket.env.CODEX_POCKET_STATE_DIR": localDirectory(),
    "mcp_servers.pocket.env.POCKET_THREAD_ID": config.threadId,
  };

  return [
    ...config.serverArgs,
    ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
  ];
}

export function pocketInstructions(existing: string, unrestricted: boolean) {
  return [
    existing,
    `You are Pocket, running inside a Codex harness on the user's computer. The phone interface is a minimal chat for this one session. ${unrestricted ? "This process has full, unrestricted access to the computer as configured by the user." : "Your access follows this process's computer-side Codex configuration."}
You have a bundled pocket MCP server for scheduled tasks: schedule_create, schedule_get, schedule_list, schedule_update and schedule_delete. Use it when asked to schedule a one-time or recurring task. Each schedule has a title, a body containing the future instructions, and iCalendar event text. Use DTSTART with UTC Z or an IANA TZID, optionally RRULE, RDATE and EXDATE. Example: DTSTART;TZID=America/Los_Angeles:20261020T090000 followed by RRULE:FREQ=DAILY. Read the current date/time on the computer before scheduling; this example is not the current time.
Pocket injects the body as a user message when due, obeying its configured steering/queueing behavior. Scheduled triggers are hidden from the phone interface; start working on the instructions normally. Your responses, questions and approval requests remain visible. One-time tasks become inactive after firing. Tasks run only while this computer is awake and Pocket is running. After downtime Pocket delivers one overdue occurrence per task and skips the rest of the missed repetitions. Check tool results before claiming a task was scheduled. Use update/delete to revise or cancel future occurrences.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function resumePocket(rpc: CodexRpc, config: Config) {
  const { config: effective } = await rpc.request<{ config: Record<string, unknown> }>("config/read", {
    includeLayers: false,
    cwd: config.cwd,
  });

  const effort = string(effective.model_reasoning_effort);

  return rpc.request<{ thread: Thread; model: string; reasoningEffort: string | null }>("thread/resume", {
    threadId: config.threadId,
    excludeTurns: true,
    ...(effort && { config: { model_reasoning_effort: effort } }),
    developerInstructions: pocketInstructions(
      string(effective.developer_instructions),
      effective.sandbox_mode === "danger-full-access"
    ),
  });
}
