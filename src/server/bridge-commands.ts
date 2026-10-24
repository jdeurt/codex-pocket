import { type Bridge } from "./bridge-session";
import { type BridgeOutbox } from "./bridge-outbox";
import { type MessageSource } from "../lib/protocol";
import { findById, withoutId } from "../lib/identity";
import { validateAnswer } from "./answers";
import { writeLocal } from "./local-state";
import { requestFile } from "./request-files";

/**
Runtime owner of user commands executed under the bridge's shared operation lease.
*/
export class BridgeCommands {
  /** Accept a user submission after connection and voice-context preparation.
  @param id - Durable delivery identity.
  @param text - User message.
  @param attachmentIds - Managed attachment identities.
  @param source - Optional voice tool provenance.
  @returns Durable delivery outcome.
  */
  send = async (id: string, text: string, attachmentIds: string[], source?: MessageSource) => {
    await this.bridge.ensureConnected();
    const { rpc, config } = this.bridge.connection();

    if (!source) {
      await this.bridge.realtime.prepareText();
    }

    return this.messages.send(config, rpc, id, text, attachmentIds, source);
  };

  /** Answer a still-pending native prompt and persist its new request state.
  @param id - Native prompt identity.
  @param input - Untrusted HTTP response.
  */
  answer = async (id: string | number, input: unknown) => {
    const request = findById(this.bridge.snapshot.requests, id);

    if (!request) {
      throw new Error("This prompt is no longer waiting for an answer.");
    }

    const rpc = this.bridge.agentReader();

    rpc.respond(id, validateAnswer(request, input));
    this.bridge.snapshot = { ...this.bridge.snapshot, requests: withoutId(this.bridge.snapshot.requests, id) };
    await writeLocal(requestFile(this.bridge.snapshot.threadId), this.bridge.snapshot.requests);
    this.bridge.snapshots.publish(this.messages.entries);
  };

  /** Retain explicit connection and durable delivery ownership.
  @param bridge - Native connection and canonical state owner.
  @param messages - Durable submission owner.
  */
  constructor(
    private readonly bridge: Bridge,
    private readonly messages: BridgeOutbox
  ) {}
}
