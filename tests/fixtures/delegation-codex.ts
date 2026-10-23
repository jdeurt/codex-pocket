import { readInternalContext } from "./internal-context";
import assert from "node:assert/strict";
import { type Turn, string, turnSchema } from "../../src/lib/protocol";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import path from "node:path";
import { writeFixtureRecord } from "./sequential-rpc";
import { z } from "zod";

const inputSchema = z.tuple([z.object({ type: z.literal("text"), text: z.string() })]);
const historySchema = z.array(turnSchema);
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;

/**
Replay native steering acknowledgements, tool phases and completion races on saved sessions.
*/
class SteeringReplay {
  private sessionId = crypto.randomUUID();

  private turns: Turn[] = [];

  private active?: Turn;

  /**
  Resolve only this replay session's private history file.
  @returns Saved native transcript path.
  */
  private filename() {
    return path.join(process.cwd(), `steering-${this.sessionId}.json`);
  }

  /**
  Persist the fake native transcript before emitting acceptance or completion.
  */
  private save() {
    writeFileSync(this.filename(), JSON.stringify(this.turns));
  }

  /**
  Emit a session-scoped native turn notification.
  @param method - Native lifecycle notification name.
  @param turn - Exact owned turn snapshot.
  */
  private event(method: string, turn: Turn) {
    writeFixtureRecord({ method, params: { threadId: this.sessionId, turn } });
  }

  /**
  Complete the owned turn and persist its terminal native state.
  */
  private complete() {
    if (!this.active) {
      return;
    }

    this.active.status = "completed";
    this.save();
    this.event("turn/completed", this.active);
    this.active = undefined;
  }

  /**
  Begin a fake native reasoning or tool phase, retaining normal turn-start semantics.
  @param request - Validated native start request.
  */
  private start(request: z.infer<typeof fixtureRequestSchema>) {
    const { content: text } = readInternalContext(inputSchema.parse(request.params.input)[0].text);
    const turn: Turn = {
      id: crypto.randomUUID(),
      status: "inProgress",
      items: [{ id: string(request.params.clientUserMessageId), type: "userMessage", text }],
    };
    const item = { id: crypto.randomUUID(), type: "agentMessage", text: `ready:${text}` };

    this.active = turn;
    this.turns.push(turn);
    this.save();
    writeFixtureRecord({ id: request.id, result: { turn } });
    this.event("turn/started", turn);
    writeFixtureRecord({
      method: "item/started",
      params: {
        threadId: this.sessionId,
        item: {
          id: crypto.randomUUID(),
          type: text === "tool" ? "commandExecution" : "reasoning",
          status: "inProgress",
        },
      },
    });
    writeFixtureRecord({ method: "item/completed", params: { threadId: this.sessionId, item } });

    if (text === "race" || text === "finish") {
      this.complete();
    }
  }

  /**
  Exercise explicit unsupported and rejected-completion paths before accepting a correction.
  @param request - Validated native steering request.
  */
  private steer(request: z.infer<typeof fixtureRequestSchema>) {
    const { content: text } = readInternalContext(inputSchema.parse(request.params.input)[0].text);

    if (text === "unsupported" || text === "reject") {
      writeFixtureRecord({
        id: request.id,
        error: {
          code: text === "unsupported" ? METHOD_NOT_FOUND : INVALID_PARAMS,
          message: "Steering rejected by this replay",
        },
      });

      return;
    }

    if (text === "race") {
      this.complete();
      writeFixtureRecord({ id: request.id, error: { code: -32_600, message: "No active turn" } });

      return;
    }

    this.accept(request, text);
  }

  /**
  Accept only the exact active turn and persist the correction before its response.
  @param request - Validated native steering request.
  @param text - Current-task message used to select the explicit replay fault.
  */
  private accept(request: z.infer<typeof fixtureRequestSchema>, text: string) {
    const active = this.active;

    if (!active || request.params.expectedTurnId !== active.id) {
      writeFixtureRecord({ id: request.id, error: { code: -32_600, message: "Expected turn does not match" } });

      return;
    }

    active.items.push({ id: string(request.params.clientUserMessageId), type: "userMessage", text });
    this.save();

    if (text === "hold-ack") {
      writeFixtureRecord({
        method: "item/completed",
        params: {
          threadId: this.sessionId,
          item: {
            id: crypto.randomUUID(),
            type: "agentMessage",
            text: "held-ack",
          },
        },
      });

      return;
    }

    if (text === "disconnect") {
      process.stdin.destroy();
      process.stdout.end();
      process.stderr.end();

      return;
    }

    if (text === "finish" || text === "accepted-before-end") {
      this.complete();
    }

    writeFixtureRecord({ id: request.id, result: { turnId: active.id } });
  }

  /**
  Restore only the requested saved replay session.
  */
  private restore() {
    const filename = this.filename();
    const saved = existsSync(filename) ? readFileSync(filename, "utf8") : "[]";

    this.turns = historySchema.parse(JSON.parse(saved));
  }

  /**
  Normalize and dispatch one native replay request without performing external work.
  @param line - Native newline-delimited JSON request.
  */
  receive(line: string) {
    const request = fixtureRequestSchema.parse(JSON.parse(line));

    if (request.method === "thread/start" || request.method === "thread/resume") {
      const instructions = string(request.params.developerInstructions);

      assert.match(instructions, /NATIVE_BASE_INSTRUCTIONS/);
      assert.match(instructions, /\[POCKET_INTERNAL_CONTEXT\]/);
      assert.match(instructions, /Include the complete/);
      assert.match(instructions, /does not authenticate/);
    }

    switch (request.method) {
      case "initialize": {
        writeFixtureRecord({ id: request.id, result: { userAgent: "pocket-workflow-native-replay" } });

        return;
      }

      case "thread/start": {
        break;
      }

      case "initialized": {
        return;
      }

      case "turn/start": {
        this.start(request);

        return;
      }

      case "turn/steer": {
        this.steer(request);

        return;
      }

      case "turn/interrupt": {
        this.complete();
        break;
      }

      case "config/read": {
        writeFixtureRecord({
          id: request.id,
          result: { config: { developer_instructions: "NATIVE_BASE_INSTRUCTIONS" } },
        });

        return;
      }

      case "thread/resume": {
        this.sessionId = string(request.params.threadId);
        this.restore();
        break;
      }

      case "thread/read": {
        writeFixtureRecord({ id: request.id, result: { thread: { id: this.sessionId, turns: this.turns } } });

        return;
      }

      default: {
        const failure = `Unexpected native replay call: ${String(request.method)}`;

        appendFileSync(path.join(process.cwd(), "unexpected-native.jsonl"), JSON.stringify(request) + "\n");
        writeFixtureRecord({ id: request.id, error: { code: METHOD_NOT_FOUND, message: failure } });

        return;
      }
    }

    writeFixtureRecord({
      id: request.id,
      result:
        request.method === "turn/interrupt"
          ? {}
          : { thread: { id: this.sessionId, turns: this.turns }, model: "offline", reasoningEffort: "medium" },
    });
  }
}

/**
Attach the native wire reader only after checking explicit offline isolation.
*/
function startReplay() {
  const replay = new SteeringReplay();
  const lines = createInterface({ input: process.stdin });

  lines.on("line", (line) => {
    replay.receive(line);
  });
}

if (!process.env.CODEX_POCKET_STATE_DIR || process.env.CODEX_THREAD_ID) {
  throw new Error("Steering replay requires isolated fake state and an empty incoming thread.");
}

startReplay();
