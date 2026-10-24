import { SIDE_PROMPTS } from "../pocket-prompts";
import { type Data, object } from "../../lib/protocol";
import {
  type HookJSONOutput,
  type HookInput,
  type Options,
  type PermissionRequestHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { type AdapterOptions } from "./types";
import { claudePermissions } from "../../state/harness-permissions";
import { log } from "../logging";
import { requireClaudeBinary } from "./claude-binary";
import { sidePocketInstructions } from "../../state/harness-instructions";
import { z } from "zod";

const HOOK_TIMEOUT_SECONDS = 3600;
const questionsAnswer = z.object({ answers: z.record(z.string(), z.string()) }).strict();

type NativeRequest = (id: string, isWaiting: boolean) => void;

/**
Validate the worker's native question answer before merging it into SDK input.
@param input - SDK permission request identifying the native tool.
@param data - Normalized native tool input.
@param callbacks - Scoped worker callbacks that own the answer boundary.
@returns Original input with validated native question answers.
*/
async function answeredQuestion(input: PermissionRequestHookInput, data: Data, callbacks: AdapterOptions["callbacks"]) {
  const answer = await callbacks.request({
    id: crypto.randomUUID(),
    kind: "question",
    method: input.tool_name,
    input: data,
  });

  return { ...data, ...questionsAnswer.parse(answer) };
}

/**
Clear native question waiting state before returning the SDK allow decision.
@param input - SDK permission request whose input has been resolved.
@param updatedInput - Original or question-augmented normalized input.
@param nativeRequest - Optional scoped native waiting-state observer.
@returns The native SDK permission hook decision.
*/
function completedPermission(
  input: PermissionRequestHookInput,
  updatedInput: Data,
  nativeRequest: NativeRequest | undefined
): HookJSONOutput {
  if (input.tool_name === "AskUserQuestion" && input.agent_id) {
    nativeRequest?.(input.agent_id, false);
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput },
    },
  };
}

/**
Mark native question waiting state before asking the worker for an answer.
@param input - SDK permission request after hook discriminator validation.
@param callbacks - Scoped worker request callbacks.
@param nativeRequest - Optional scoped native waiting-state observer.
@returns The SDK permission decision after any question has been answered.
*/
async function requestedPermission(
  input: PermissionRequestHookInput,
  callbacks: AdapterOptions["callbacks"],
  nativeRequest: NativeRequest | undefined
) {
  const data = object(input.tool_input);
  const isQuestion = input.tool_name === "AskUserQuestion";

  if (isQuestion && input.agent_id) {
    nativeRequest?.(input.agent_id, true);
  }

  return completedPermission(input, isQuestion ? await answeredQuestion(input, data, callbacks) : data, nativeRequest);
}

/** Route the SDK permission hook to the explicit scoped worker callbacks.
@param callbacks - Worker that owns native question answers.
@param nativeRequest - Optional task waiting-state publisher.
@param input - SDK hook payload.
@returns The supported permission decision or an empty unrelated-hook result.
*/
async function permissionHook(
  callbacks: AdapterOptions["callbacks"],
  nativeRequest: NativeRequest | undefined,
  input: HookInput
) {
  return input.hook_event_name === "PermissionRequest" ? requestedPermission(input, callbacks, nativeRequest) : {};
}

/** Record native stderr with its explicit child identity.
@param childId - Owning delegated child.
@param message - Native stderr text.
*/
function diagnostic(childId: string, message: string) {
  log().debug({ message, childId }, "side_pocket.claude.stderr");
}

/**
Build native SDK options with inherited permissions, prompts and scoped parent tools.
@param options - Validated child context and worker callbacks.
@param sessionId - Stable native child session identity.
@param shouldResume - Whether the SDK should resume the existing native session.
@param nativeRequest - Optional scoped native waiting-state observer.
@returns Native SDK options preserving current runtime prompt and tool behavior.
*/
export function claudeOptions(
  options: AdapterOptions,
  sessionId: string,
  shouldResume: boolean,
  nativeRequest?: NativeRequest
): Options {
  const { child, callbacks, parentTools } = options;
  const inheritedEffort = child.effort ?? child.policy.effort;
  const effort = inheritedEffort === "minimal" ? "low" : inheritedEffort;

  return {
    ...claudePermissions(child.policy),
    cwd: child.cwd,
    ...(shouldResume ? { resume: sessionId } : { sessionId }),
    ...((child.model ?? process.env.POCKET_CLAUDE_MODEL) && { model: child.model ?? process.env.POCKET_CLAUDE_MODEL }),
    ...(effort && { effort: z.enum(["low", "medium", "high", "xhigh", "max"]).parse(effort) }),
    pathToClaudeCodeExecutable: requireClaudeBinary(),
    systemPrompt: { type: "preset", preset: "claude_code", append: sidePocketInstructions(child, SIDE_PROMPTS) },
    title: `Side Pocket: ${child.title}`,
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    strictMcpConfig: true,
    mcpServers: parentTools ? { pocket_parent: { type: "stdio", ...parentTools } } : {},
    persistSession: true,
    stderr: diagnostic.bind(undefined, child.id),
    hooks: {
      PermissionRequest: [
        {
          timeout: HOOK_TIMEOUT_SECONDS,
          hooks: [permissionHook.bind(undefined, callbacks, nativeRequest)],
        },
      ],
    },
  };
}
