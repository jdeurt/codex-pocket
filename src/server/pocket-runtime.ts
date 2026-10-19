import { type Thread, string } from "../lib/protocol";
import type { CodexRpc } from "./rpc";
import type { Config } from "./config";
import { delegations } from "./delegations";
import { localDirectory } from "./local-state";
import { parentPolicy } from "./harness/permissions";
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
    "mcp_servers.pocket.env.POCKET_MAIN_THREAD_ID": config.threadId,
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
Pocket displays image-view output and tool image content directly in the phone chat. An image returned by a tool is already visible to the user.
For display-only requests, prefer one Markdown image with the absolute file path. Use an image-view tool when you need to inspect the image.
Do not copy or host the file merely to display it. Use one delivery method per requested image. After tool image output, do not repeat that image in Markdown or another message. Repeat an image only when the user requests it or the task requires separate views. Confirm delivery in the final reply without embedding the image again.
To offer a dedicated Copy text button, emit a top-level Markdown fenced block with exactly the info string pocket-copy and exactly three backticks on each fence. The body must be one valid JSON string containing the exact text to copy. Encode newlines as \\n, quotes as \\" and backslashes as \\\\ (use JSON.stringify when preparing arbitrary text); Unicode may remain literal. Example:
\`\`\`pocket-copy
"Line 1\\nLine 2"
\`\`\`
The phone replaces only a complete, closed, valid marker in your assistant message with a button. It copies the decoded string only when the user presses it; never claim it was copied before that action. Use this marker when the user requests a copy button or when a dedicated copy action helps them use text you provide. To explain the syntax without creating a button, put the entire marker inside an ordinary longer code fence. Do not use HTML, executable links or javascript: URLs for copy actions.
You can delegate work to independent Side Pockets using side_pocket_create. Choose harness codex or claude; main Pocket runs Codex. Use side_pocket_capabilities for current protocol capabilities. Both harnesses support saved sessions, queued follow-ups and parent messaging. Codex children inherit your model and effort unless overridden; Claude children use their Claude model default and inherit your effort unless overridden. Claude requires your effective policy to be danger-full-access with approvals never; unsupported policy mappings are rejected.
Use side_pocket_list to look up titles and IDs, side_pocket_get to inspect messages/results/requests, and side_pocket_send to send assignments or answers by ID. Give create/send a stable idempotencyKey and reuse it for retries of the same operation. Follow-ups run after the current child turn. Children use message_parent for progress, questions and results; those reports arrive here with their child identity. Reply to ordinary child questions with side_pocket_send. Harness requests include a request ID for side_pocket_answer.
Use side_pocket_close to stop a child's process and cancel queued work; side_pocket_resume reopens its saved identity for later messages. Inspect an unknown delivery before resuming and sending instructions to continue; Pocket preserves it rather than replaying uncertain work. A closed session keeps its history. Side Pockets have your effective filesystem/command permissions, their harness's native tools/skills/subagents and message_parent. Pocket scheduling and Side Pocket management tools are available to this main session. Coordinate ownership of shared files or assign separate worktrees for overlapping changes. Delegate when useful for the task.
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
  const instructions = pocketInstructions(
    string(effective.developer_instructions),
    effective.sandbox_mode === "danger-full-access"
  );

  const resumed = await rpc.request<{
    thread: Thread;
    model: string;
    reasoningEffort: string | null;
    approvalPolicy?: unknown;
    sandbox?: { type: string };
  }>("thread/resume", {
    threadId: config.threadId,
    excludeTurns: true,
    ...(effort && { config: { model_reasoning_effort: effort } }),
    developerInstructions: instructions,
  });
  const sandboxModes: Record<string, string> = {
    dangerFullAccess: "danger-full-access",
    readOnly: "read-only",
    workspaceWrite: "workspace-write",
  };
  delegations().saveParent(config.threadId, {
    cwd: config.cwd,
    policy: parentPolicy({
      ...effective,
      sandbox_mode: sandboxModes[resumed.sandbox?.type ?? ""] ?? effective.sandbox_mode,
      approval_policy: resumed.approvalPolicy ?? effective.approval_policy,
      model: resumed.model,
      model_reasoning_effort: resumed.reasoningEffort ?? effort,
    }),
  });

  return resumed;
}
