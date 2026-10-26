import type { DelegationStore, SidePocket } from "./delegations";
import type { Config } from "./config";
import type { HarnessRequest } from "./harness/types";

interface WaitingRequest {
  childId: string;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
}

/**
Resolves native harness waiters from durable parent answers and cancellation.
*/
export class DelegationQuestions {
  private waiting = new Map<string, WaitingRequest>();

  /**
  Binds question waiters to the same durable mailbox and parent identity as dispatch.
  @param store - Durable child and question owner.
  @param config - Shared configuration selecting the current parent.
  */
  constructor(
    private store: DelegationStore,
    private config: Config
  ) {}

  /**
  Persists a native question and waits for a durable answer or cancellation.
  @param child - Child asking the question.
  @param commandId - Exact native assignment asking the question.
  @param request - Native harness question and response contract.
  @returns Answer supplied by the parent; cancellation rejects.
  */
  request(child: SidePocket, commandId: string, request: HarnessRequest) {
    const id = this.store.mail.request(child.parentId, child.id, request, commandId);

    this.store.setStatus(child.parentId, child.id, "waiting");

    const pending = Promise.withResolvers<unknown>();

    this.waiting.set(id, { childId: child.id, resolve: pending.resolve, reject: pending.reject });

    return pending.promise;
  }

  /**
  Resolves registered native questions only after their durable answer or cancellation.
  */
  answers() {
    for (const child of this.store.list(this.config.threadId)) {
      for (const request of this.store.mail.requests(child.parentId, child.id)) {
        const waiting = this.waiting.get(request.id);

        if (!waiting || request.status === "pending") {
          continue;
        }

        this.waiting.delete(request.id);

        if (
          request.status === "answered" &&
          request.answer !== null &&
          this.store.continueChild(child.parentId, child.id)
        ) {
          waiting.resolve(JSON.parse(request.answer));
        } else {
          waiting.reject(new Error("Side Pocket request was cancelled."));
        }
      }
    }
  }

  /**
  Rejects in-process waiters during shutdown while preserving saved native sessions.
  */
  stop() {
    for (const waiting of this.waiting.values()) {
      waiting.reject(new Error("Pocket is stopping; this request can be continued in the saved session."));
    }

    this.waiting.clear();
  }
}
