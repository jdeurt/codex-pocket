import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RpcEvent } from "../lib/protocol";
import { piActivity, piActivityEvent } from "../state/pi-activity";
import { observable } from "../runtime/stores";

/**
Own progress publication separately from pure native activity decisions.
*/
export class PiActivity {
  private readonly store = observable(new Map<string, string>());

  /** Bind progress publication to one parent.
  @param threadId - Parent identity.
  @param emit - Canonical event sink.
  */
  constructor(
    private threadId: string,
    private emit: (event: RpcEvent) => void
  ) {}

  /** Publish an immutable transition from authoritative native execution.
  @param event - Native lifecycle event.
  @param turnId - Current canonical submission.
  */
  accept(event: AgentSessionEvent, turnId: string | undefined) {
    const next = piActivity(this.store.getState(), event);
    const activity = piActivityEvent(next, this.threadId, turnId);

    this.store.setState(next.tools, true);

    if (activity) {
      this.emit(activity);
    }
  }
}
