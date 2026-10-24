import { dataSchema } from "../lib/protocol";

const CONTROL_TIMEOUT_MS = 40_000;

/**
Call this main Pocket's control endpoint without opening another native client.
@param change - Optional preference change or an explicitly identified voice-call termination.
@returns Authorized control result.
*/
export async function callRealtime(
  change?: { voice?: string; model?: string | null } | { action: "end"; sessionId: string }
) {
  const origin = process.env.POCKET_SERVER_ORIGIN;

  if (
    !origin ||
    !process.env.POCKET_MAIN_THREAD_ID ||
    process.env.POCKET_THREAD_ID !== process.env.POCKET_MAIN_THREAD_ID
  ) {
    throw new Error("Realtime controls are available only to the owning main Pocket.");
  }

  const response = await fetch(
    new URL(`/api/realtime?pocket=${encodeURIComponent(process.env.POCKET_ID ?? "main")}`, origin),
    {
      method: change ? "POST" : "GET",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: change ? JSON.stringify({ action: "settings", ...change }) : undefined,
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }
  );
  const result = dataSchema.parse(await response.json());

  if (!response.ok) {
    throw new Error(typeof result.error === "string" ? result.error : "Realtime control failed.");
  }

  return result;
}
