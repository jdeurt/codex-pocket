import { type Item, type Turn, string, turnSchema } from "../../src/lib/protocol";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import path from "node:path";
import { z } from "zod";

const SESSION = "fixture-native-session";
const REQUEST = "fixture-native-question";
const wireSchema = fixtureRequestSchema.extend({ result: z.unknown().optional() });
const answerChoiceSchema = z.object({ answers: z.tuple([z.literal("Blue")]) });
const answerSchema = z.object({ answers: z.object({ color: answerChoiceSchema }) });
const historySchema = z.array(turnSchema);
const inputSchema = z.tuple([z.object({ type: z.literal("text"), text: z.string() })]);

/**
Write one offline native protocol record without invoking a model.
@param value - Native response or notification from this replay.
*/
function emit(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/**
Read only the explicitly isolated replay's durable native history.
@param filename - History file inside this fake child's working directory.
@returns Validated chronological native turns, or an empty new-session history.
*/
function savedTurns(filename: string) {
  return existsSync(filename) ? historySchema.parse(JSON.parse(readFileSync(filename, "utf8"))) : [];
}

/**
Own the offline native session, its pending question and its saved history.
*/
class ReplaySession {
  private turns: Turn[];

  private active?: Turn;

  /**
  Restore this isolated fake native session before accepting RPC input.
  @param filename - Private replay history file.
  */
  constructor(private filename: string) {
    this.turns = savedTurns(filename);
  }

  /**
  Complete the pending native turn and persist its canonical output.
  */
  private finish() {
    if (!this.active) {
      throw new Error("Replay completion requires an active turn.");
    }

    this.complete(this.active);
  }

  /**
  Record output before emitting native item and turn completion notifications.
  @param turn - Active replay turn whose pending question was answered.
  */
  private complete(turn: Turn) {
    const item: Item = { id: `${turn.id}:answer`, type: "agentMessage", text: "Chosen Blue", phase: "final_answer" };

    turn.items.push(item);
    turn.status = "completed";
    writeFileSync(this.filename, JSON.stringify(this.turns));
    emit({ method: "item/completed", params: { threadId: SESSION, item } });
    emit({ method: "turn/completed", params: { threadId: SESSION, turn } });
    this.active = undefined;
  }

  /**
  Replay scoped descendant discovery and native input before completing a delegated turn.
  @param request - Validated native turn request.
  */
  private start(request: z.infer<typeof wireSchema>) {
    const input = inputSchema.parse(request.params.input);
    const turn: Turn = {
      id: string(request.params.clientUserMessageId),
      status: "inProgress",
      items: [{ id: `${String(request.id)}:user`, type: "userMessage", text: input[0].text }],
    };

    this.active = turn;
    this.turns.push(turn);
    emit({ id: request.id, result: { turn } });
    emit({ method: "turn/started", params: { threadId: SESSION, turn } });

    if (input[0].text === "disconnect") {
      process.stderr.write("Isolated replay disconnect\n");
      process.stdin.destroy();
      process.stdout.end();
      process.stderr.end();

      return;
    }

    emit({
      method: "thread/started",
      params: { thread: { id: "native-descendant", parentThreadId: SESSION, name: "Native child" } },
    });
    emit({
      method: "thread/status/changed",
      params: { threadId: "native-descendant", status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
    });
    emit({
      method: "thread/started",
      params: { thread: { id: "unrelated-native", parentThreadId: "unrelated-owner", name: "Unrelated" } },
    });
    emit({
      id: REQUEST,
      method: "item/tool/requestUserInput",
      params: { threadId: SESSION, questions: [{ id: "color", question: "Choose a color" }] },
    });
  }

  /**
  Replay supported native methods and reject unsupported fixture requests.
  @param request - Validated offline wire record.
  @returns The native method result.
  */
  private result(request: z.infer<typeof wireSchema>): unknown {
    switch (request.method) {
      case "initialize":
      case "thread/archive": {
        return {};
      }

      case "config/read": {
        return { config: { developer_instructions: "Existing replay instructions" } };
      }

      case "thread/start":
      case "thread/resume": {
        return { thread: { id: SESSION, turns: this.turns }, model: "offline-replay", reasoningEffort: null };
      }

      case "thread/read": {
        return { thread: { id: SESSION, turns: this.turns } };
      }

      case "thread/turns/list": {
        return { data: this.turns, nextCursor: null };
      }

      default: {
        throw new Error(`Unsupported replay method: ${String(request.method)}`);
      }
    }
  }

  /**
  Validate each wire record once before dispatching native requests or answers.
  @param line - Newline-delimited native JSON input.
  */
  receive(line: string) {
    const request = wireSchema.parse(JSON.parse(line));

    if (request.id === REQUEST && request.method === undefined) {
      answerSchema.parse(request.result);
      this.finish();

      return;
    }

    if (request.method === "initialized") {
      return;
    }

    if (request.method === "turn/start") {
      this.start(request);

      return;
    }

    emit({ id: request.id, result: this.result(request) });
  }
}

/**
Start the isolated native replay only after its explicit guard has passed.
*/
function main() {
  const session = new ReplaySession(path.join(process.cwd(), "native-history.json"));
  const lines = createInterface({ input: process.stdin });

  lines.on("line", (line) => {
    session.receive(line);
  });
}

if (process.env.POCKET_CODEX_SESSION_REPLAY !== "1" || process.env.CODEX_THREAD_ID) {
  throw new Error("Native session replay requires explicit offline mode and an empty attached thread.");
}

main();
