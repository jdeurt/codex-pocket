import { type Request, type Response, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import {
  configureVoice,
  installRealtimePeer,
  openVoice,
  providerAction,
  startVoice,
} from "../../fixtures/realtime-browser";
import { type Data, dataSchema } from "../../../src/lib/protocol";

const STREAM_DURATION_MS = 10_000;
const CAPTION_DELAY_MS = 12_000;

test("native WebRTC streams both ways past eight seconds while captions are delayed and preserves drafts", async ({
  page,
}) => {
  const commands: string[] = [];

  page.on("request", (request) => {
    if (!(new URL(request.url()).pathname === "/api/realtime" && request.method() === "POST")) {
      return;
    }

    const command = dataSchema.parse(request.postDataJSON());

    commands.push(String(command.action));
  });
  await configureVoice({
    finalDelayMs: CAPTION_DELAY_MS,
    transcript: "A delayed caption.",
    replyText: "Streaming reply.",
  });
  await installRealtimePeer(page);
  await openVoice(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("unsent draft");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("draft attachment") });
  await expect(page.getByText("note.txt")).toBeVisible();
  await startVoice(page);
  await providerAction("speech");
  await expect
    .poll(async () => {
      const stats = await page.evaluate(() => globalThis.pocketMediaProbe.stats());

      return stats.received > 0 && stats.sent > 0;
    })
    .toBe(true);
  const before = await page.evaluate(() => globalThis.pocketMediaProbe.stats());

  // A sustained real-media check must exceed the removed eight-second playback limit.
  await page.waitForTimeout(STREAM_DURATION_MS);
  const after = await page.evaluate(() => globalThis.pocketMediaProbe.stats());

  expect(after.received).toBeGreaterThan(before.received);
  expect(after.sent).toBeGreaterThan(before.sent);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText("A delayed caption.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Audio playback fell behind/)).toHaveCount(0);
  expect(commands).toEqual(["start"]);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("unsent draft");
  await expect(page.getByText("note.txt")).toBeVisible();
  expect(await page.evaluate(() => globalThis.pocketMediaProbe.microphone?.readyState)).toBe("ended");
  expect(commands).toEqual(["start", "stop"]);
});

test("microphone permission failure retains the draft and permits text work", async ({ page }) => {
  await configureVoice();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) },
    });
  });
  await openVoice(page);
  const composer = page.getByRole("textbox", { name: "Message Pocket" });

  await composer.fill("Continue after permission failed.");
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Permission denied")).toBeVisible();
  await expect(composer).toHaveValue("Continue after permission failed.");
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();
});

/** Retain only content-free timing diagnostics observed at the browser's HTTP boundary.
@param records - Test-owned observed reports.
@param request - Actual browser request.
*/
function collectTiming(records: Data[], request: Request) {
  if (!request.url().endsWith("/api/logs") || request.method() !== "POST") {
    return;
  }

  const body = dataSchema.parse(request.postDataJSON());

  if (Array.isArray(body.events)) {
    for (const value of body.events) {
      const event = dataSchema.parse(value);

      if (event.event === "realtime.response_timing") {
        records.push(dataSchema.parse(event.details));
      }
    }
  }
}

/** Observe completed SDP negotiation independently of candidate availability in the test host.
@param response - Real browser negotiation response.
@returns Whether the call offer has reached the synthetic provider.
*/
function isVoiceNegotiated(response: Response) {
  return response.url().endsWith("/api/realtime") && response.request().method() === "POST";
}

test("provider timing diagnostics omit speech content and leave captions independent", async ({ page }) => {
  const records: Data[] = [];
  const expectedRecords = 1;
  const expectedMediaGap = 100;
  const privateText = "Private speech that must never enter timing diagnostics.";
  const visibleReply = "Captions remain independent of timing diagnostics.";

  page.on("request", collectTiming.bind(undefined, records));
  await configureVoice({ replyText: visibleReply });
  await installRealtimePeer(page, true);
  await openVoice(page);
  const negotiated = page.waitForResponse(isVoiceNegotiated.bind(undefined));

  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await negotiated;
  await page.evaluate((text) => {
    const channel = globalThis.pocketMediaProbe.channel;

    if (!channel) {
      throw new Error("Native provider channel was not created");
    }

    channel.dispatchEvent(new MessageEvent("message", { data: "malformed optional metadata" }));
    const inputEnd = 100;
    const outputStart = 200;
    const outputMiddle = 300;
    const outputEnd = 400;
    const frames = [
      { type: "session.input_transcript.delta", event_id: "input-private", delta: text, start_ms: 0, end_ms: inputEnd },
      {
        type: "session.output_transcript.delta",
        event_id: "output-private",
        delta: text,
        start_ms: outputStart,
        end_ms: outputMiddle,
      },
      {
        type: "session.output_transcript.delta",
        event_id: "output-next",
        delta: text,
        start_ms: outputMiddle,
        end_ms: outputEnd,
      },
    ];

    for (const frame of frames) {
      channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }, privateText);
  await providerAction("speech");
  await expect(page.getByText(visibleReply, { exact: true })).toBeVisible();
  await expect.poll(() => records.length).toBe(expectedRecords);
  expect(records.map((record) => record.phase)).toEqual(["output_transcript_started"]);
  expect(records[0].inputCaptionToOutputCaptionMs).toBeGreaterThanOrEqual(0);
  expect(records[0].mediaGapMs).toBe(expectedMediaGap);
  expect(JSON.stringify(records)).not.toContain(privateText);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});
