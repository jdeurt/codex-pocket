import { type Bridge } from "./bridge-session";
import { type CodexRpc } from "./rpc";
import { audioSchema } from "./realtime-schema";
import type { z } from "zod";

const MAX_PENDING_SAMPLES = 48_000;

interface MediaSession {
  token?: string;
  nativeSessionId?: string;
  phase: string;
}
interface CapturedMedia {
  token: string;
  nativeSessionId?: string;
  threadId?: string;
  rpc: CodexRpc;
  audio: z.infer<typeof audioSchema>;
}

/**
Keep native media ordered and bounded independently of ordinary bridge controls.
*/
export class RealtimeMediaLane {
  private serial: Promise<void> = Promise.resolve();
  private pendingSamples = 0;

  /**
  Create an ordered media lane for one native parent bridge.
  @param owner - Existing single native parent bridge.
  @param session - Current realtime identity and phase accessor.
  */
  constructor(
    private owner: Bridge,
    private session: () => MediaSession
  ) {}

  /**
  Require the active browser token before accepting audio.
  @param token - Browser session token.
  @returns Native session identity bound to this token.
  */
  private accepting(token: string) {
    const current = this.session();

    if (!current.token || token !== current.token || current.phase !== "active") {
      throw new Error("Realtime has stopped.");
    }

    return current.nativeSessionId;
  }

  /**
  Validate PCM16 shape, decoded byte length, and pending duration.
  @param input - Untrusted audio request payload.
  @returns Validated native audio chunk.
  */
  private validated(input: unknown) {
    const audio = audioSchema.parse(input);

    if (Buffer.from(audio.data, "base64").byteLength !== audio.samplesPerChannel * 2) {
      throw new Error("Invalid PCM16 audio length.");
    }

    if (this.pendingSamples + audio.samplesPerChannel > MAX_PENDING_SAMPLES) {
      throw new Error("Audio connection is too slow.");
    }

    return audio;
  }

  /**
  Capture all identities used when this chunk eventually dispatches.
  @param token - Browser token already checked against the session.
  @param input - Untrusted audio request payload.
  @returns Audio plus immutable session, thread, and RPC identities.
  */
  private capture(token: string, input: unknown): CapturedMedia {
    const nativeSessionId = this.accepting(token);
    const audio = this.validated(input);
    const threadId = this.owner.snapshot.threadId;
    const rpc = this.owner.agentReader();

    return { token, nativeSessionId, threadId, rpc, audio };
  }

  /**
  Reject queued media if stop, restart, thread switch, or RPC replacement occurred.
  @param captured - Identity captured when this chunk was enqueued.
  */
  private assertCurrent(captured: CapturedMedia) {
    const now = this.session();

    if (
      captured.token !== now.token ||
      captured.nativeSessionId !== now.nativeSessionId ||
      now.phase !== "active" ||
      this.owner.snapshot.threadId !== captured.threadId ||
      this.owner.snapshot.connection !== "connected" ||
      !captured.rpc.running ||
      this.owner.agentReader() !== captured.rpc
    ) {
      throw new Error("Realtime has stopped.");
    }
  }

  /**
  Send one chunk after earlier media, then release its pending-sample budget.
  @param previous - Prior media completion barrier.
  @param captured - Audio and immutable owner identities.
  */
  private async dispatch(previous: Promise<void>, captured: CapturedMedia) {
    try {
      await previous;
      this.assertCurrent(captured);
      await captured.rpc.request("thread/realtime/appendAudio", {
        threadId: captured.threadId,
        audio: captured.audio,
      });
    } finally {
      this.pendingSamples -= captured.audio.samplesPerChannel;
    }
  }

  /**
  Keep the next chunk runnable after a previous chunk fails.
  @param sent - Current chunk result observed by its HTTP request.
  */
  private async settle(sent: Promise<void>) {
    try {
      await sent;
    } catch {
      // The requesting HTTP call observes its failure; later media can still dispatch.
    }
  }

  /**
  Bind one request to its captured session and RPC, checking again at dispatch.
  @param token - Browser token for this audio request.
  @param input - Untrusted PCM16 chunk.
  @returns Native acknowledgement for this exact chunk.
  */
  append(token: string, input: unknown) {
    const captured = this.capture(token, input);
    const previous = this.serial;
    const sent = this.dispatch(previous, captured);

    this.pendingSamples += captured.audio.samplesPerChannel;
    this.serial = this.settle(sent);

    return sent;
  }
}
