import { BUILD_VERSION, CONNECTION_LOST_EVENT } from "@/lib/build-version";
import { z } from "zod";
import { t as attempt } from "try";

const CHECK_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5000;
const INPUT_IDLE_MS = 2000;
const RELOAD_KEY = "pocket-release-refresh";

const versionSchema = z.object({ version: z.string().min(1) });

/**
Record a refresh before navigating so stale HTML cannot trap the page in a reload loop.
@param version - Different build advertised by the server.
@returns Whether this old/new build pair has not already been refreshed.
*/
function canClaimRefresh(version: string) {
  const pair = `${BUILD_VERSION}:${version}`;

  if (sessionStorage.getItem(RELOAD_KEY) === pair) {
    return false;
  }

  sessionStorage.setItem(RELOAD_KEY, pair);

  return true;
}

/**
Reload once per build pair when durable browser storage is available.
@param version - Different release confirmed by an uncached server response.
*/
function refresh(version: string) {
  // Without storage we cannot guarantee a bounded refresh or recover all browser state.
  const outcome = attempt(canClaimRefresh, version);

  if (outcome.ok && outcome.value) {
    globalThis.location.reload();
  }
}

/**
Validate the live build endpoint without accepting an error page as release metadata.
@param signal - Cancellation bound to this subscription and its request timeout.
@returns Valid server version, or undefined for an unsuccessful response.
*/
async function readVersion(signal: AbortSignal) {
  const response = await fetch("/api/version", { cache: "no-store", signal });
  const data: unknown = response.ok ? await response.json() : undefined;

  return versionSchema.safeParse(data).data?.version;
}

/**
Treat a restart or offline response as temporary unavailability, preserving the open page.
@param signal - Cancellation for the bounded network request.
@returns Confirmed build version when the server is available.
*/
async function fetchVersion(signal: AbortSignal) {
  return (async () => readVersion(signal))().catch(() => {
    return;
  });
}

/**
Adopt a new UI after a host update without interrupting a send or losing unsaved input.
@param isSafe - Reads current composer and durable attachment state synchronously.
@returns Cleanup for the update probe and browser event subscriptions.
*/
export function subscribeAppUpdates(isSafe: () => boolean) {
  let request: AbortController | undefined;
  let isStopped = false;
  let isComposing = false;
  let lastInput = 0;

  const input = () => {
    lastInput = Date.now();
  };
  const composition = (event: Event) => {
    isComposing = event.type === "compositionstart";
    input();
  };

  async function probe(controller: AbortController) {
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const version = await fetchVersion(controller.signal);

    clearTimeout(timeout);
    request = undefined;

    if (
      !isStopped &&
      !isComposing &&
      version &&
      version !== BUILD_VERSION &&
      document.visibilityState === "visible" &&
      Date.now() - lastInput >= INPUT_IDLE_MS &&
      isSafe()
    ) {
      refresh(version);
    }
  }

  const check = async () => {
    if (request || document.visibilityState !== "visible") {
      return;
    }

    request = new AbortController();
    await probe(request);
  };

  const wake = () => {
    void check();
  };
  const interval = setInterval(wake, CHECK_INTERVAL_MS);

  wake();
  globalThis.addEventListener("online", wake);
  globalThis.addEventListener("pageshow", wake);
  globalThis.addEventListener(CONNECTION_LOST_EVENT, wake);
  document.addEventListener("visibilitychange", wake);
  document.addEventListener("input", input);
  document.addEventListener("compositionstart", composition);
  document.addEventListener("compositionend", composition);

  return () => {
    isStopped = true;
    request?.abort();
    clearInterval(interval);
    globalThis.removeEventListener("online", wake);
    globalThis.removeEventListener("pageshow", wake);
    globalThis.removeEventListener(CONNECTION_LOST_EVENT, wake);
    document.removeEventListener("visibilitychange", wake);
    document.removeEventListener("input", input);
    document.removeEventListener("compositionstart", composition);
    document.removeEventListener("compositionend", composition);
  };
}
