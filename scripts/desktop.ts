import { pendingRequestSchema, pretty } from "../src/lib/protocol";
import { readLocal, writeLocal } from "../src/server/local-state";
import nextEnv from "@next/env";
import { z } from "zod";

nextEnv.loadEnvConfig(process.cwd());
const [command, requestId, payload] = process.argv.slice(2);
const pending = z.array(pendingRequestSchema).parse(await readLocal("requests.json", []));

if (command === "requests") {
  console.info(pretty(pending));
} else if (command === "respond" && requestId && payload) {
  const request = pending.find((entry) => String(entry.id) === requestId);

  if (!request) {
    throw new Error("That request is no longer pending.");
  }

  const result: unknown = JSON.parse(payload);

  await writeLocal(`reply-${crypto.randomUUID()}.json`, { id: request.id, result });
  console.info("Answer queued for Codex.");
} else {
  console.info("npm run desktop -- requests\nnpm run desktop -- respond REQUEST_ID 'JSON_RESULT'");
}
