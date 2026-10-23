import { type ClaudeScenario, ClaudeSimulator } from "./claude";
import { type Data, object, string } from "../../src/lib/protocol";
import { CodexSimulator } from "./codex";
import { type ScriptedCall } from "./contract";
import { type TurnScenario } from "./codex-turns";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { z } from "zod";

const NOT_FOUND = -1;

const recordSchema = z.record(z.string(), z.unknown());
const serverRequestSchema = z.object({ method: z.string(), params: recordSchema });

const scriptSchema: z.ZodType<ScriptedCall> = z.object({
  method: z.string(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  before: z.array(recordSchema).optional(),
  after: z.array(recordSchema).optional(),
  disconnect: z.boolean().optional(),
  delayMs: z.number().nonnegative().optional(),
});
const turnSchema: z.ZodType<TurnScenario> = z.object({
  chunks: z.array(z.string()).optional(),
  hold: z.boolean().optional(),
  failure: z.string().optional(),
  requests: z.array(serverRequestSchema).optional(),
  usage: recordSchema.optional(),
});
const claudeSchema: z.ZodType<ClaudeScenario> = z.object({
  text: z.string().optional(),
  hold: z.boolean().optional(),
  failure: z.string().optional(),
  requests: z.array(recordSchema).optional(),
  messages: z.array(recordSchema).optional(),
  controls: z.array(scriptSchema).optional(),
});
const scenario = process.env.POCKET_SIMULATOR_SCENARIO
  ? object(JSON.parse(readFileSync(process.env.POCKET_SIMULATOR_SCENARIO, "utf8")))
  : {};

/**
Write one protocol line with no diagnostic contamination on stdout.
@param record - Server response or unsolicited message.
*/
function emit(record: Data) {
  if (string(object(record.error).message).includes("SIMULATOR_DISCONNECT")) {
    process.stdin.destroy();
    process.stdout.destroy();
    process.exitCode = 1;

    return;
  }

  process.stdout.write(JSON.stringify(record) + "\n");
}

/**
Read native launch flags forwarded by the actual Claude SDK.
@param name - Native flag.
@returns Optional flag value.
*/
function flag(name: string) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));

  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = process.argv.indexOf(name);

  return index === NOT_FOUND ? undefined : process.argv[index + 1];
}

const simulator =
  process.env.POCKET_SIMULATOR_HARNESS === "claude"
    ? new ClaudeSimulator(emit, {
        ...claudeSchema.parse(scenario.claude ?? {}),
        sessionId: flag("--session-id") ?? flag("--resume"),
        model: flag("--model"),
        permissionMode: flag("--permission-mode"),
      })
    : new CodexSimulator(emit, {
        stateFile: process.env.POCKET_SIMULATOR_STATE,
        scripts: z.array(scriptSchema).parse(scenario.scripts ?? []),
        turn: turnSchema.parse(scenario.turn ?? {}),
      });

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  await simulator.receive(JSON.parse(line));
}
