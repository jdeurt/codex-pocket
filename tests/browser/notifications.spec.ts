import { expect, test } from "@playwright/test";
import webpush from "web-push";

const ENDPOINT = "https://push.example/browser-notification-test";
const CHALLENGE_ID = "8dc07b30-0615-4b1f-9980-8611e6b53852";

test("notification presence follows foreground visibility, page restoration and network reconnection", async ({
  page,
}) => {
  const { publicKey } = webpush.generateVAPIDKeys();
  const acknowledgements: unknown[] = [];
  const count = () => page.evaluate(() => Number(Reflect.get(globalThis, "pocketPresenceCount")));
  const probe = () => page.evaluate(() => globalThis.dispatchEvent(new Event("pocket-probe")));

  await page.route("**/api/notifications", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { publicKey } : { subscribed: true } })
  );
  await page.route("**/api/notifications/presence", async (route) => {
    acknowledgements.push(route.request().postDataJSON());
    await route.fulfill({ json: { acknowledged: true } });
  });
  await page.addInitScript(
    ({ endpoint, key, challengeId }) => {
      const subscription = {
        endpoint,
        options: { applicationServerKey: Uint8Array.from(key).buffer },
        toJSON: () => ({ endpoint }),
      };
      const registration = { pushManager: { getSubscription: () => Promise.resolve(subscription) } };
      const sources: (EventTarget & { closed: boolean; close: () => void })[] = [];

      Object.defineProperty(navigator, "serviceWorker", {
        value: { register: () => Promise.resolve(registration), ready: Promise.resolve(registration) },
      });
      Object.defineProperties(globalThis, {
        Notification: { value: { permission: "granted" } },
        PushManager: { value: {} },
      });
      const NativeSource = EventSource;

      Object.defineProperty(globalThis, "EventSource", {
        value: function PresenceSource(url: string) {
          if (!url.includes("/notifications/presence?")) {
            return new NativeSource(url);
          }

          const connection = Object.assign(new EventTarget(), {
            closed: false,
            close: () => {
              connection.closed = true;
            },
          });

          sources.push(connection);

          return connection;
        },
      });
      let isVisible = true;

      Object.defineProperty(document, "visibilityState", { get: () => (isVisible ? "visible" : "hidden") });
      Object.defineProperty(globalThis, "pocketPresenceCount", {
        get: () => sources.filter((source) => !source.closed).length,
      });
      globalThis.addEventListener("pocket-visibility", (event) => {
        isVisible = event instanceof CustomEvent && event.detail === true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      globalThis.addEventListener("pocket-probe", () => {
        for (const source of sources) {
          source.dispatchEvent(new MessageEvent("probe", { data: JSON.stringify({ challengeId }) }));
        }
      });
    },
    { endpoint: ENDPOINT, key: [...Buffer.from(publicKey, "base64url")], challengeId: CHALLENGE_ID }
  );
  await page.goto("/");

  await expect.poll(count).toBe(1);
  await probe();
  await expect.poll(() => acknowledgements.length).toBe(1);
  const deviceId = await page.evaluate(async (endpoint) => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
    const HEX_RADIX = 16;

    return [...new Uint8Array(digest)].map((value) => value.toString(HEX_RADIX).padStart(2, "0")).join("");
  }, ENDPOINT);

  expect(acknowledgements[0]).toEqual({ deviceId, challengeId: CHALLENGE_ID });
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent("pocket-visibility", { detail: false })));
  await expect.poll(count).toBe(0);
  await probe();
  expect(acknowledgements).toHaveLength(1);
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent("pocket-visibility", { detail: true })));
  await expect.poll(count).toBe(1);

  for (const [close, reopen] of [
    ["offline", "online"],
    ["pagehide", "pageshow"],
  ]) {
    await page.evaluate((name) => globalThis.dispatchEvent(new Event(name)), close);
    await expect.poll(count).toBe(0);
    await probe();
    expect(acknowledgements).toHaveLength(1);
    await page.evaluate((name) => globalThis.dispatchEvent(new Event(name)), reopen);
    await expect.poll(count).toBe(1);
  }

  await probe();
  await expect.poll(() => acknowledgements.length).toBe(2);
});
