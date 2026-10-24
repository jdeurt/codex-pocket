import { BUILD_VERSION, CONNECTION_LOST_EVENT } from "@/lib/build-version";
import { EventBindings } from "../runtime/events";
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
  const completed = await attempt(readVersion, signal);

  if (completed.ok) {
    return completed.value;
  }

  return;
}

/**
Runtime owner of update probes, user-input timing and navigation effects.
*/
class AppUpdates {
  private request: AbortController | undefined;
  private isStopped = false;
  private isComposing = false;
  private lastInput = 0;
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly events: EventBindings;

  /**
  Record browser input at the clock boundary.
  */
  private input = () => {
    this.lastInput = Date.now();
  };

  /** Track IME composition so a refresh cannot interrupt it.
  @param event - Native composition lifecycle event.
  */
  private composition = (event: Event) => {
    this.isComposing = event.type === "compositionstart";
    this.input();
  };

  /**
  Probe the host and refresh only after confirming durable work and user inactivity.
  */
  private check = async () => {
    if (this.request || document.visibilityState !== "visible") {
      return;
    }

    const controller = new AbortController();

    this.request = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const version = await fetchVersion(signal);

    this.request = undefined;

    if (this.canRefresh(version)) {
      refresh(version);
    }
  };

  /**
  Schedule a probe from a timer or native lifecycle callback.
  */
  private wake = () => {
    void this.check();
  };

  /**
  Cancel outstanding requests and release all native listeners.
  */
  stop = () => {
    this.isStopped = true;
    this.request?.abort();
    clearInterval(this.interval);
    this.events.stop();
  };

  /** Begin observing input and host versions after mount.
  @param isSafe - Explicit runtime read of current durable-work status.
  */
  constructor(private readonly isSafe: () => boolean) {
    this.interval = setInterval(this.wake, CHECK_INTERVAL_MS);
    this.events = new EventBindings([
      [globalThis, "online", this.wake],
      [globalThis, "pageshow", this.wake],
      [globalThis, CONNECTION_LOST_EVENT, this.wake],
      [document, "visibilitychange", this.wake],
      [document, "input", this.input],
      [document, "compositionstart", this.composition],
      [document, "compositionend", this.composition],
    ]);
    this.wake();
  }

  /** Read current runtime conditions after a possibly delayed version response.
  @param version - Version returned by the host, if reachable.
  @returns Whether this response can safely trigger navigation.
  */
  private canRefresh(version: string | undefined): version is string {
    return (
      !this.isStopped &&
      !this.isComposing &&
      !!version &&
      version !== BUILD_VERSION &&
      document.visibilityState === "visible" &&
      Date.now() - this.lastInput >= INPUT_IDLE_MS &&
      this.isSafe()
    );
  }
}

/** Start the effectful update lifetime using an explicit current-state reader.
@param isSafe - Runtime read of current durable-work status.
@returns Cleanup for probes, cancellation and input listeners.
*/
export function subscribeAppUpdates(isSafe: () => boolean) {
  return new AppUpdates(isSafe).stop;
}
