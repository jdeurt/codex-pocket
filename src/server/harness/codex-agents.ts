import { type Data, type RpcEvent, object, string } from "../../lib/protocol";
import { codexActivity, codexParent } from "../../lib/codex";
import type { AgentEntry } from "../../lib/agents";

const OBSERVED_EVENTS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/completed",
  "thread/closed",
  "thread/archived",
  "thread/deleted",
]);
const CLOSED_EVENTS = new Set(["thread/closed", "thread/archived", "thread/deleted"]);

type NativeAgents = Record<string, Pick<AgentEntry, "parentId" | "name" | "status">>;

/**
Track native descendants discovered through the owning Codex session's events.
*/
export class CodexAgents {
  private entries: NativeAgents = {};

  /**
  Apply live and terminal status only to a previously scoped descendant.
  @param event - Validated native event.
  @param thread - Native thread metadata from this event.
  @param id - Known descendant identity.
  */
  private status(event: RpcEvent, thread: Data, id: string) {
    if (event.method === "thread/status/changed" || event.method === "thread/started") {
      this.entries[id].status = codexActivity(object(event.params.status ?? thread.status));
    } else if (CLOSED_EVENTS.has(event.method)) {
      this.entries[id].status = "closed";
    } else if (event.method === "turn/completed") {
      const status = string(object(event.params.turn).status);

      this.entries[id].status = status === "completed" || status === "failed" ? status : "idle";
    }
  }

  /**
  Discover descendants only through known ancestry before updating their status.
  @param event - Relevant validated native event.
  @param sessionId - Owning native session identity, when established.
  @returns The shared scoped metadata after an update, or undefined for unrelated threads.
  */
  private update(event: RpcEvent, sessionId: string | undefined): NativeAgents | undefined {
    const thread = object(event.params.thread);
    const id = string(thread.id) || string(event.params.threadId);
    const parentId = codexParent(thread);

    if (
      parentId &&
      event.method === "thread/started" &&
      (parentId === sessionId || Object.hasOwn(this.entries, parentId))
    ) {
      this.entries[id] = {
        parentId,
        name: string(thread.name) || string(thread.agentNickname),
        status: "unknown",
      };
    }

    if (!Object.hasOwn(this.entries, id)) {
      return undefined;
    }

    this.status(event, thread, id);

    return this.entries;
  }

  /**
  Ignore unrelated protocol methods before inspecting native ancestry metadata.
  @param event - Validated native protocol event.
  @param sessionId - Owning native session identity, when established.
  @returns Updated scoped metadata only when a known descendant changed.
  */
  observe(event: RpcEvent, sessionId: string | undefined) {
    return OBSERVED_EVENTS.has(event.method) ? this.update(event, sessionId) : undefined;
  }
}
