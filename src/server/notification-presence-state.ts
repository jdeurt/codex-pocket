import { createHash, randomUUID } from "node:crypto";
import { t as attempt } from "try";

const FOREGROUND_PROBE_TIMEOUT_MS = 1500;

type Probe = (challengeId: string) => void;
interface Challenge {
  deviceId: string;
  finish: (isVisible: boolean) => void;
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

    return () => {
      if (!connections.delete(probe) || connections.size > 0) {
        return;
      }

      this.connections.delete(deviceId);

      for (const challenge of this.challenges.values()) {
        if (challenge.deviceId === deviceId) {
          challenge.finish(false);
        }
      }
    };
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

    challenge.finish(true);

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

    // A stale open stream cannot mute a locked, suspended or disconnected phone.
    return new Promise<boolean>((resolve) => {
      const challengeId = randomUUID();
      const timer = setTimeout(() => {
        this.challenges.delete(challengeId);
        resolve(false);
      }, FOREGROUND_PROBE_TIMEOUT_MS);
      const finish = (isVisible: boolean) => {
        clearTimeout(timer);
        this.challenges.delete(challengeId);
        resolve(isVisible);
      };

      this.challenges.set(challengeId, { deviceId, finish });

      for (const probe of connections) {
        const outcome = attempt(() => {
          probe(challengeId);
        });

        if (!outcome.ok) {
          // A broken stream must not prevent the normal push path.
          connections.delete(probe);
        }
      }
    });
  }
}
