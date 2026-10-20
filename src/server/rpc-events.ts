import type { RpcEvent } from "../lib/protocol";

/**
A native notification carrying the already validated protocol event.
*/
export class RpcNotificationEvent extends Event {
  /**
  Preserve the validated native event for transport subscribers.
  @param notification - Protocol event accepted at the JSON boundary.
  */
  constructor(readonly notification: RpcEvent) {
    super("event");
  }
}

/**
A transport diagnostic kept in host logging rather than public snapshots.
*/
export class RpcDiagnosticEvent extends Event {
  /**
  Carry one decoded native stderr chunk.
  @param text - Native diagnostic text.
  */
  constructor(readonly text: string) {
    super("diagnostic");
  }
}

/**
A terminal connection failure shared by pending requests and subscribers.
*/
export class RpcDisconnectEvent extends Event {
  /**
  Carry the connection's original terminal error.
  @param error - Failure that closed this native connection.
  */
  constructor(readonly error: Error) {
    super("disconnect");
  }
}
