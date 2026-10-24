import { endpoint, guard, noStore, readBody } from "@/server/http";
import { requestBridge } from "@/server/named-pockets";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_SDP_LENGTH = 100_000;

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), sdp: z.string().min(1).max(MAX_SDP_LENGTH) }).strict(),
  z.object({ action: z.literal("stop"), token: z.uuid() }).strict(),
  z.object({ action: z.literal("end"), sessionId: z.uuid() }).strict(),
  z
    .object({ action: z.literal("settings"), voice: z.string().optional(), model: z.string().nullable().optional() })
    .strict(),
]);

/**
Read OpenAI voices, central next-session preferences and finalized speech.
@param request - Browser request selecting its saved Pocket.
@returns Private preferences and history response.
*/
export const GET = endpoint(async (request: Request) => {
  await guard(request);

  const bridge = await requestBridge(request);

  const info = await bridge.realtime.info();

  return Response.json(info, { headers: noStore });
});

/**
Dispatch one scoped control through the selected Pocket's OpenAI voice session.
@param request - Authorized control request.
@returns The validated control result.
*/
async function applyCommand(request: Request) {
  const input = command.parse(await readBody(request));
  const { realtime } = await requestBridge(request);

  switch (input.action) {
    case "start": {
      const started = await realtime.start(input.sdp);

      if (request.signal.aborted) {
        await realtime.stop(started.token);
        throw new Error("Realtime setup was cancelled.");
      }

      return started;
    }

    case "stop": {
      await realtime.stop(input.token);

      return { stopped: true };
    }

    case "end": {
      return { stopped: await realtime.endSession(input.sessionId) };
    }

    case "settings": {
      return realtime.update({ voice: input.voice, model: input.model });
    }
  }
}

/**
Authorize and encode a realtime control without coupling media to the HTTP error boundary.
@param request - Browser control request.
@returns Private control result response.
*/
export const POST = endpoint(async (request: Request) => {
  await guard(request, true);

  const result = await applyCommand(request);

  return Response.json(result, { headers: noStore });
});
