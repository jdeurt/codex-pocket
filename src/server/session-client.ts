import { dataSchema } from "../lib/protocol";
import { type sessionSettingsSchema } from "./session-settings";
import { type z } from "zod";

const REQUEST_TIMEOUT_MS = 15_000;

/**
Require the host-provided control origin before opening a local HTTP request.
@returns The origin belonging to this main Pocket's live connection.
*/
function sessionOrigin() {
  const origin = process.env.POCKET_SERVER_ORIGIN;

  if (!origin) {
    throw new Error("The Pocket host did not configure its control endpoint. Reconnect the main Pocket first.");
  }

  return origin;
}

/**
Call only this main Pocket's typed control route; never open another native connection.
@param settings - Optional explicit model/effort mutation; omission performs inspection.
@returns The connected host's effective settings or an explicit error without replay.
*/
export async function callSession(settings?: z.infer<typeof sessionSettingsSchema>) {
  const origin = sessionOrigin();
  const response = await fetch(new URL("/api/session", origin), {
    method: settings ? "POST" : "GET",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: settings ? JSON.stringify(settings) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = dataSchema.parse(await response.json());

  if (!response.ok) {
    throw new Error(
      typeof result.error === "string" ? result.error : "Session control failed; inspect before retrying."
    );
  }

  return result;
}
