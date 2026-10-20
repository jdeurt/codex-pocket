import { type Data, object, string } from "./protocol";
import type { AgentStatus } from "./agents";

/**
Resolve native Codex ancestry from explicit parent metadata rather than prompt text.
@param thread - Normalized native metadata containing optional parent and source fields.
@returns Native parent identity, or an empty string when ancestry is absent.
*/
export function codexParent(thread: Data) {
  const source = object(thread.source);
  const agent = object(source.subAgent);

  return string(thread.parentThreadId) || string(object(agent.thread_spawn).parent_thread_id);
}

/**
Normalize live Codex status without inferring completion from saved history.
@param status - Normalized native status object.
@returns Current activity, system failure, idle state or unavailable status.
*/
export function codexActivity(status: Data): AgentStatus {
  if (status.type === "active") {
    return Array.isArray(status.activeFlags) && status.activeFlags.length > 0 ? "waiting" : "running";
  }

  if (status.type === "systemError") {
    return "failed";
  }

  return status.type === "idle" ? "idle" : "unknown";
}
