/* eslint-disable jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity -- Route authorization and native dispatch are sequential. */
import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { requestBridge } from "@/server/named-pockets";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("stop"), token: z.uuid() }).strict(),
  z.object({ action: z.literal("audio"), token: z.uuid(), audio: z.unknown() }).strict(),
  z
    .object({ action: z.literal("settings"), voice: z.string().optional(), model: z.string().nullable().optional() })
    .strict(),
]);

/**
Read native realtime voices and this parent's next-session selection.
*/
export async function GET(request: Request) {
  try {
    await guard(request);

    const bridge = await requestBridge(request);
    const info = await bridge.realtime.info();

    return Response.json(info, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
Dispatch one scoped control through the selected parent's existing native bridge.
*/
export async function POST(request: Request) {
  try {
    await guard(request, true);
    const input = command.parse(await readBody(request));
    const { realtime } = await requestBridge(request);

    let result: unknown;

    switch (input.action) {
      case "start": {
        result = await realtime.start();
        break;
      }

      case "stop": {
        await realtime.stop(input.token);
        result = { stopped: true };
        break;
      }

      case "audio": {
        await realtime.append(input.token, input.audio);
        result = { accepted: true };
        break;
      }

      case "settings": {
        result = await realtime.update({ voice: input.voice, model: input.model });
        break;
      }
    }

    return Response.json(result, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
