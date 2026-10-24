import { type Data, object, string } from "../lib/protocol";
import { RpcError, rpcResponseSchemas } from "./rpc-protocol";
import { log } from "./logging";
import { t as attempt } from "try";

const ACKNOWLEDGEMENT_TIMEOUT_MS = 90_000;

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
}

/**
Runtime owner of native acknowledgement identities, timers and pending completions.
*/
export class RpcAcknowledgements {
  private sequence = 0;
  private pending = new Map<number, PendingResponse>();

  /** Bind the owning connection's native write and close operations.
  @param write - Native frame writer.
  @param close - Native transport shutdown request.
  */
  constructor(
    private readonly write: (message: unknown) => void,
    private readonly close: () => void
  ) {}

  /** Validate a known method response before settling its pending request.
  @param pending - Acknowledgement owner already removed from the pending map.
  @param value - Untrusted native result value.
  */
  private result(pending: PendingResponse, value: unknown) {
    const schema = rpcResponseSchemas.get(pending.method);

    if (!schema) {
      pending.resolve(value);

      return;
    }

    const outcome = attempt(schema.parse.bind(schema), value);

    if (outcome.ok) {
      pending.resolve(outcome.value);

      return;
    }

    pending.reject(new Error(`Invalid ${pending.method} response.`, { cause: outcome.error }));
  }

  /** Reject an uncertain acknowledgement and stop its owning transport.
  @param id - Expired native request identity.
  @param method - Native request method for diagnostics.
  */
  private expired(id: number, method: string) {
    const pending = this.pending.get(id);

    if (!pending) {
      return;
    }

    log().error({ method, id }, "codex.rpc.timeout");
    this.pending.delete(id);
    pending.reject(
      new RpcError(`Codex did not acknowledge ${method}. Its outcome is unknown; check the thread before retrying.`)
    );
    this.close();
  }

  /** Consume one matching acknowledgement and retain its native error or result.
  @param id - Numeric request identity from the decoded response.
  @param message - Decoded native response object.
  */
  response(id: number, message: Data) {
    const pending = this.pending.get(id);

    if (!pending) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    log().debug(
      { method: pending.method, id: message.id, durationMs: Date.now() - pending.startedAt, error: message.error },
      "codex.rpc.acknowledged"
    );

    if (message.error) {
      const error = object(message.error);

      pending.reject(new RpcError(string(error.message), typeof error.code === "number" ? error.code : undefined));

      return;
    }

    this.result(pending, message.result);
  }

  /**
  Allocate an identity and reject uncertain requests when acknowledgement expires.
  @param method - Native JSON-RPC method.
  @param params - Native request parameters.
  @returns The acknowledged native result.
  */
  request(method: string, params: Data) {
    const id = ++this.sequence;
    const completion = Promise.withResolvers<unknown>();
    const timer = setTimeout(this.expired.bind(this, id, method), ACKNOWLEDGEMENT_TIMEOUT_MS);

    this.pending.set(id, { ...completion, timer, method, startedAt: Date.now() });
    const written = attempt(this.write.bind(this), { id, method, params });

    if (!written.ok) {
      clearTimeout(timer);
      this.pending.delete(id);
      completion.reject(written.error);
    }

    return completion.promise;
  }

  /** Reject outstanding requests after native disconnect.
  @param error - Original transport failure.
  */
  fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }
}
