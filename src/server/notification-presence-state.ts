import { log } from "./logging";
import { createHash, randomUUID } from "node:crypto";
import { t as attempt } from "try";

const FOREGROUND_PROBE_TIMEOUT_MS = 1500;

type Probe = (challengeId: string) => void;
interface Challenge {
  deviceId: string;
  resolve: (isVisible: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
Hash a native push endpoint into the existing presence-stream device identity.
@param endpoint - Native subscription endpoint.
@returns Stable SHA-256 hexadecimal device identity.
*/
export const notificationDeviceId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

/**
Track native presence streams and require fresh visible acknowledgements before muting push.
*/
export class NotificationPresence {
  private connections = new Map<string, Set<Probe>>();

  private challenges = new Map<string, Challenge>();

  /** Release a completed native challenge and its timer once.
  @param id - Exact outstanding challenge.
  @param isVisible - Whether its device acknowledged foreground visibility.
  */
  private finish(id: string, isVisible: boolean) {
    const challenge = this.challenges.get(id);

    if (!challenge) {
      return;
    }

    clearTimeout(challenge.timer);
    this.challenges.delete(id);
    challenge.resolve(isVisible);
  }

  /** Remove one native stream and release challenges after its final connection closes.
  @param deviceId - Owning device identity.
  @param probe - Exact native stream callback.
  */
  private disconnect(deviceId: string, probe: Probe) {
    const connections = this.connections.get(deviceId);

    if (!connections?.delete(probe) || connections.size > 0) {
      return;
    }

    this.connections.delete(deviceId);
    const pending: string[] = [];

    for (const [id, challenge] of this.challenges) {
      if (challenge.deviceId === deviceId) {
        pending.push(id);
      }
    }

    for (const id of pending) {
      this.finish(id, false);
    }
  }

  /**
Register one device's foreground probe callback until its exact subscription closes.
@param deviceId - Hashed native push endpoint identity.
@param probe - Callback that sends a fresh challenge on this device's stream.
@returns Cleanup removing this callback and resolving disconnected device challenges false.
*/
  connect(deviceId: string, probe: Probe) {
    const connections = this.connections.get(deviceId) ?? new Set<Probe>();

    connections.add(probe);
    this.connections.set(deviceId, connections);

    return this.disconnect.bind(this, deviceId, probe);
  }

  /**
Accept a fresh challenge only from its still-connected owning device.
@param deviceId - Hashed endpoint identity attached to the acknowledgement.
@param challengeId - Outstanding nonce returned by the visible client.
@returns Whether a matching active challenge was acknowledged.
*/
  acknowledge(deviceId: string, challengeId: string) {
    const challenge = this.challenges.get(challengeId);

    if (challenge?.deviceId !== deviceId || !this.connections.has(deviceId)) {
      return false;
    }

    this.finish(challengeId, true);

    return true;
  }

  /**
Require a fresh acknowledgement from a connected device before suppressing its push.
@param endpoint - Native push endpoint whose current visibility must be proven.
@returns Whether a matching active client answered before the bounded deadline.
*/
  async isForeground(endpoint: string) {
    const deviceId = notificationDeviceId(endpoint);
    const connections = this.connections.get(deviceId);

    if (!connections?.size) {
      return false;
    }

    const challengeId = randomUUID();
    const completion = Promise.withResolvers<boolean>();
    const timer = setTimeout(this.finish.bind(this, challengeId, false), FOREGROUND_PROBE_TIMEOUT_MS);

    this.challenges.set(challengeId, { deviceId, resolve: completion.resolve, timer });
    const failed: Probe[] = [];

    for (const probe of connections) {
      const outcome = attempt(probe, challengeId);

      if (outcome.ok) {
        continue;
      }

      failed.push(probe);
      log().warn({ error: outcome.error, deviceId }, "push.presence_probe_failed");
    }

    for (const probe of failed) {
      this.disconnect(deviceId, probe);
    }

    return completion.promise;
  }
}
