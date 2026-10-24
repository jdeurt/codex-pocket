import { type Page, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { type Data, dataSchema } from "../../src/lib/protocol";
import path from "node:path";

const directory = path.resolve(".local/realtime-fixture");
const controlFile = path.join(directory, "control.json");

interface MediaProbe {
  answer: (sdp: string) => Promise<string>;
  stats: () => Promise<{ received: number; sent: number }>;
  microphone?: MediaStreamTrack;
  channel?: RTCDataChannel;
}

declare global {
  var pocketMediaProbe: MediaProbe;
}

/** Use two native browser peers to test actual RTP in both directions without a live provider.
@param page - Browser before app load.
@param shouldObserveTiming - Whether to expose the native metadata channel for protocol-driven timing checks.
*/
export async function installRealtimePeer(page: Page, shouldObserveTiming = false) {
  await page.addInitScript((shouldObserve) => {
    const peers: RTCPeerConnection[] = [];

    const probe: MediaProbe = {
      answer: async (sdp) => {
        const peer = new RTCPeerConnection();
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();

        peers.push(peer);
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        peer.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
        await peer.setRemoteDescription({ type: "offer", sdp });
        await peer.setLocalDescription(await peer.createAnswer());

        if (peer.iceGatheringState !== "complete") {
          await new Promise<void>((resolve) => {
            peer.addEventListener("icegatheringstatechange", () => {
              if (peer.iceGatheringState === "complete") {
                resolve();
              }
            });
          });
        }

        return peer.localDescription?.sdp ?? "";
      },
      stats: async () => {
        let received = 0;
        let sent = 0;

        for (const peer of peers) {
          const reports = await peer.getStats();

          reports.forEach((report: { type: string; bytesReceived?: number; bytesSent?: number }) => {
            if (report.type === "inbound-rtp") {
              received += report.bytesReceived ?? 0;
            } else if (report.type === "outbound-rtp") {
              sent += report.bytesSent ?? 0;
            }
          });
        }

        return { received, sent };
      },
    };

    Object.defineProperty(globalThis, "pocketMediaProbe", { configurable: true, value: probe });

    if (shouldObserve) {
      const NativePeer = RTCPeerConnection;

      /**
      Observe actual native data channels without replacing their transport behavior.
      */
      class ObservedPeer extends NativePeer {
        /** Record the same native channel returned to the application.
        @param label - Requested native channel label.
        @param options - Native channel negotiation options.
        @returns The original browser-owned channel.
        */
        override createDataChannel(label: string, options?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, options);

          globalThis.pocketMediaProbe.channel = channel;

          return channel;
        }
      }

      Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: ObservedPeer });
    }

    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);

      globalThis.pocketMediaProbe.microphone = stream.getAudioTracks()[0];

      return stream;
    };
  }, shouldObserveTiming);
  await page.route("**/api/realtime", async (route) => {
    const request = route.request();

    if (request.method() !== "POST") {
      await route.continue();

      return;
    }

    const body = dataSchema.parse(request.postDataJSON());

    if (body.action !== "start" || typeof body.sdp !== "string") {
      await route.continue();

      return;
    }

    const answerSdp = await page.evaluate((sdp) => globalThis.pocketMediaProbe.answer(sdp), body.sdp);
    const saved = dataSchema.parse(JSON.parse(await readFile(controlFile, "utf8")));

    await writeFile(controlFile, JSON.stringify({ ...saved, answerSdp }));
    await route.fulfill({ response: await route.fetch() });
  });
}

/** Set the synthetic model's next utterance; media itself remains native WebRTC.
@param options - Fixed provider response and worker scenario.
*/
export async function configureVoice(options: Data = {}) {
  await writeFile(controlFile, JSON.stringify(options));
}

/** Trigger provider control events independently of the native media stream.
@param action - Simulated speech completion or server-control loss.
*/
export async function providerAction(action: "speech" | "disconnect") {
  const url = await readFile(path.join(directory, "provider-url"), "utf8");
  const response = await fetch(new URL(`/test/${action}`, url), { method: "POST" });

  expect(response.ok).toBe(true);
}

/** Open the actual application and dismiss its first-run notice.
@param page - Browser connected to the fixture app.
*/
export async function openVoice(page: Page) {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
}

/** Activate voice with a real gesture and wait for the media connection.
@param page - Loaded application.
*/
export async function startVoice(page: Page) {
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
}
