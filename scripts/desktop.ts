import { pendingRequestSchema, pretty } from "../src/lib/protocol";
import { readLocal, writeLocal } from "../src/server/local-state";
import nextEnv from "@next/env";
import { z } from "zod";

/**
Parses a desktop answer only after the request has been found in durable state.
@param id - Validated pending native question identity.
@param payload - Entered JSON answer.
@returns Completion of the atomically queued local reply.
*/
async function queueAnswer(id: string | number, payload: string) {
  const result: unknown = JSON.parse(payload);

  await writeLocal(`reply-${crypto.randomUUID()}.json`, { id, result });
}

/**
Reads pending native questions and queues an explicitly selected desktop answer.
@returns Completion of the requested local desktop operation.
*/
async function desktop() {
  const [command, requestId, payload] = process.argv.slice(2);
  const pending = z.array(pendingRequestSchema).parse(await readLocal("requests.json", []));

  if (command === "requests") {
    console.info(pretty(pending));
  } else if (command === "respond" && requestId && payload) {
    const request = pending.find((entry) => String(entry.id) === requestId);

    if (!request) {
      throw new Error("That request is no longer pending.");
    }

    await queueAnswer(request.id, payload);
    console.info("Answer queued for Codex.");
  } else {
    console.info("npm run desktop -- requests\nnpm run desktop -- respond REQUEST_ID 'JSON_RESULT'");
  }
}

nextEnv.loadEnvConfig(process.cwd());

await desktop();
