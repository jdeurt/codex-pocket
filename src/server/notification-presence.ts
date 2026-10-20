import { createHash, randomUUID } from "node:crypto";

const FOREGROUND_PROBE_TIMEOUT_MS = 1500;

type Probe = (challengeId: string) => void;
interface Challenge {
  deviceId: string;
  finish: (isVisible: boolean) => void;
}

export const notificationDeviceId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

export class NotificationPresence {
  private connections = new Map<string, Set<Probe>>();

  private challenges = new Map<string, Challenge>();

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

  acknowledge(deviceId: string, challengeId: string) {
    const challenge = this.challenges.get(challengeId);

    if (challenge?.deviceId !== deviceId || !this.connections.has(deviceId)) {
      return false;
    }

    challenge.finish(true);

    return true;
  }

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
        try {
          probe(challengeId);
        } catch {
          // A broken stream must not prevent the normal push path.
          connections.delete(probe);
        }
      }
    });
  }
}

declare global {
  var codexPocketNotificationPresence: NotificationPresence | undefined;
}

const presence = globalThis.codexPocketNotificationPresence ?? new NotificationPresence();

if (!globalThis.codexPocketNotificationPresence) {
  Object.defineProperty(globalThis, "codexPocketNotificationPresence", {
    value: presence,
    configurable: true,
  });
}

export const notificationPresence = presence;
