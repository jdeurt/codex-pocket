import { type Data } from "../../src/lib/protocol";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import { unexpectedRequest } from "./unexpected-request";

type FixtureExecutor = (method: string | undefined, params: Data) => Promise<unknown>;

/**
Write one response or notification from a sequential offline native fixture.
@param record - Native record produced by the owning fixture.
*/
export function writeFixtureRecord(record: unknown) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

/**
Validate a complete request before catching only execution and response failures.
@param line - Complete JSON line from the native stdin pipe.
@param execute - Domain executor owned by the restart or upload fixture.
@returns Completion of the response write, or no operation for a record without an ID.
*/
async function respond(line: string, execute: FixtureExecutor) {
  const request = fixtureRequestSchema.parse(JSON.parse(line));

  if (request.id === undefined) {
    if (request.method !== "initialized") {
      unexpectedRequest(request.method);
    }

    return;
  }

  try {
    writeFixtureRecord({ id: request.id, result: await execute(request.method, request.params) });
  } catch (error) {
    writeFixtureRecord({
      id: request.id,
      error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
Consume actual stdin in order and await each offline native operation before the next line.
@param execute - Domain executor owned by the restart or upload fixture.
@returns Completion when the owning host closes stdin.
*/
export async function readFixtureRequests(execute: FixtureExecutor) {
  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    await respond(line, execute);
  }
}

/**
Allow a realtime stop to be read while an earlier synthetic audio acknowledgment is withheld.
@param execute - The isolated realtime fixture executor.
*/
export async function readPipelinedFixtureRequests(execute: FixtureExecutor) {
  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    void respond(line, execute).catch((error: unknown) => {
      process.stderr.write(error instanceof Error ? error.message : "Invalid fixture request.");
    });
  }
}
