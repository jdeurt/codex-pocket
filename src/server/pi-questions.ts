import { valueAfterCleanup } from "../lib/results";
import { t } from "try";
import { type PendingRequest, type RpcEvent } from "../lib/protocol";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { validateAnswer } from "./answers";

const optionSchema = Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) });
const questionSchema = Type.Object({
  id: Type.String(),
  question: Type.String(),
  header: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(optionSchema)),
});
const parameters = Type.Object({ questions: Type.Array(questionSchema, { minItems: 1 }) });

/**
Preserve Pocket's structured phone questions as a Pi tool with native cancellation.
*/
export class PiQuestions {
  private pending = new Map<string, { request: PendingRequest; resolve: (answer: unknown) => void }>();

  /** Bind question requests and responses to the existing parent/turn identity.
  @param owner - Durable parent identity.
  @param turnId - Current canonical main turn.
  @param emit - Existing bridge event sink.
  */
  constructor(
    private owner: string,
    private turnId: () => string | undefined,
    private emit: (event: RpcEvent) => void
  ) {}

  /** Publish one pending question and wait for a validated phone answer or native cancellation.
  @param callId - Original Pi tool call identity.
  @param input - Typed user questions.
  @param signal - Pi's tool cancellation signal.
  @returns Validated original phone answer.
  */
  private async ask(callId: string, input: { questions: unknown[] }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const turnId = this.turnId();

    if (!turnId) {
      throw new Error("This Pi question has no active parent turn.");
    }

    const id = `pi-question:${crypto.randomUUID()}`;
    const request: PendingRequest = {
      id,
      method: "item/tool/requestUserInput",
      params: { threadId: this.owner, turnId, itemId: callId, questions: input.questions },
    };
    const waiting = Promise.withResolvers<unknown>();
    const abort = waiting.reject.bind(undefined, new DOMException("The Pi question was cancelled.", "AbortError"));

    this.pending.set(id, { request, resolve: waiting.resolve });
    signal?.addEventListener("abort", abort, { once: true });

    const sent = t(this.emit, request);
    const completed = sent.ok ? await t(waiting.promise) : sent;

    signal?.removeEventListener("abort", abort);
    this.pending.delete(id);
    const resolved = t(this.emit, {
      method: "serverRequest/resolved",
      params: { threadId: this.owner, requestId: id },
    });

    return valueAfterCleanup(completed, resolved);
  }

  /** Execute one native question tool using the canonical phone protocol.
  @param callId - Native invocation identity.
  @param input - Validated questions.
  @param signal - Native cancellation signal.
  @returns Original answer as native tool content.
  */
  private async execute(callId: string, input: { questions: unknown[] }, signal?: AbortSignal) {
    const answer = await this.ask(callId, input, signal);

    return { content: [{ type: "text" as const, text: JSON.stringify(answer) }], details: answer };
  }

  /** Expose the existing interactive-question shape to Pi without inventing another phone UI.
  @returns Pi tool definition using the canonical native-question protocol.
  */
  tool(): ToolDefinition<typeof parameters> {
    return {
      name: "request_user_input",
      label: "Ask the user",
      description: "Ask for necessary missing information using Pocket's phone question controls.",
      parameters,
      execute: this.execute.bind(this),
    };
  }

  /** Resolve only a still-pending question through Pocket's existing answer validator.
  @param id - Exact host question identity.
  @param input - Phone answer already checked by Bridge, validated again at this boundary.
  */
  answer(id: string, input: unknown) {
    const pending = this.pending.get(id);

    if (!pending) {
      throw new Error("This Pi question is no longer waiting for an answer.");
    }

    pending.resolve(validateAnswer(pending.request, input));
  }
}
