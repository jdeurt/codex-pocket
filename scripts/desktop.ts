import { pendingRequestSchema, pretty } from "../src/lib/protocol";
import { readLocal, writeLocal } from "../src/server/local-state";
import { configForPocket } from "../src/server/pocket-config";
import nextEnv from "@next/env";
import { requestFile } from "../src/server/request-files";
import { z } from "zod";

/**
Parses a desktop answer only after the request has been found in durable state.
@param id - Validated pending native question identity.
@param payload - Entered JSON answer.
@param threadId - Explicit owning native parent.
@returns Completion of the atomically queued local reply.
*/
async function queueAnswer(id: string | number, payload: string, threadId: string) {
  const result: unknown = JSON.parse(payload);

  await writeLocal(`reply-${crypto.randomUUID()}.json`, { id, result, threadId });
}

/**
Reads pending native questions and queues an explicitly selected desktop answer.
@returns Completion of the requested local desktop operation.
*/
async function desktop() {
  const [command, requestId, payload] = process.argv.slice(2);
  const config = await configForPocket(process.env.POCKET_ID ?? "main");
  const pending = z.array(pendingRequestSchema).parse(await readLocal(requestFile(config.threadId), []));

  if (command === "requests") {
    console.info(pretty(pending));
  } else if (command === "respond" && requestId && payload) {
    const request = pending.find((entry) => String(entry.id) === requestId);

    if (!request) {
      throw new Error("That request is no longer pending.");
    }

    await queueAnswer(request.id, payload, config.threadId);
    console.info("Answer queued for Codex.");
  } else {
    console.info("npm run desktop -- requests\nnpm run desktop -- respond REQUEST_ID 'JSON_RESULT'");
  }
}

nextEnv.loadEnvConfig(process.cwd());

await desktop();
