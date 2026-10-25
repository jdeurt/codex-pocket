import { type Page, type Response, expect } from "@playwright/test";
import { t as captureResult } from "try";
import { test } from "../../fixtures/browser-workflow";
import { configureVoice, installRealtimePeer, openVoice } from "../../fixtures/realtime-browser";

const HOLD_MS = 400;
const SWIPE_PX = 80;

// This script runs at browser module scope, independently of the Node test runner.
const stalledSpectrum = `
const nativeVoiceResume = AudioContext.prototype.resume;
let voiceResumeCalls = 0;
function resumeVoiceProbe() {
  voiceResumeCalls += 1;
  return voiceResumeCalls === 1 ? Promise.withResolvers().promise : nativeVoiceResume.call(this);
}
AudioContext.prototype.resume = resumeVoiceProbe;
`;
const rejectedSpectrum = stalledSpectrum.replace(
  "Promise.withResolvers().promise",
  'Promise.reject(new DOMException("Playback blocked", "NotAllowedError"))'
);
const pendingPermission = `
function pendingVoicePermission() {
  return Promise.withResolvers().promise;
}
navigator.mediaDevices.getUserMedia = pendingVoicePermission;
`;

/** Hold and release the actual send control after an upward mouse swipe.
@param page - Browser displaying the idle composer.
*/
async function swipeVoice(page: Page) {
  const control = page.getByRole("button", { name: /Send message; hold and swipe up/ });
  const bounds = await control.boundingBox();

  if (!bounds) {
    throw new Error("The send control must be visible before swiping.");
  }

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.move(x, y - SWIPE_PX);
  await page.mouse.up();
}

/** Read actual native capture rather than the composer's optimistic display.
@returns Whether a live, enabled microphone track exists in the browser.
*/
function isMicrophoneLive() {
  const track = globalThis.pocketMediaProbe.microphone;

  return track?.readyState === "live" && track.enabled;
}

/** Read the microphone's native lifetime from the browser.
@returns Current track state, absent before capture.
*/
function microphoneState() {
  return globalThis.pocketMediaProbe.microphone?.readyState;
}

/** Observe actual native capture through the browser boundary.
@param page - Browser whose native microphone is observed by the media fixture.
@returns Whether a live, enabled microphone track exists.
*/
async function hasLiveMicrophone(page: Page) {
  return page.evaluate(isMicrophoneLive);
}

/** Observe negotiation independently of native candidate availability on the test host.
@param response - Browser HTTP response.
@returns Whether the voice control endpoint accepted a request.
*/
function isNegotiated(response: Response) {
  return response.url().endsWith("/api/realtime") && response.request().method() === "POST";
}

/** Require microphone capture and a negotiated session from one real swipe.
@param page - Loaded application with native media fixtures.
*/
async function captureFromSwipe(page: Page) {
  const negotiated = captureResult(page.waitForResponse.bind(page), isNegotiated.bind(undefined));

  await swipeVoice(page);
  await expect.poll(hasLiveMicrophone.bind(undefined, page)).toBe(true);
  const response = await negotiated;

  if (!response.ok) {
    throw response.error;
  }

  expect(response.value.ok()).toBe(true);
}

/** Verify capture, negotiation and retry independently of the first spectrum resume.
@param script - Browser audio-context failure fixture.
@param fixtures - Browser owned by the isolated realtime fixture.
*/
async function startsWithoutSpectrum(script: string, { page }: { page: Page }) {
  await configureVoice();
  await page.addInitScript({ content: script });
  await installRealtimePeer(page);
  await openVoice(page);
  await captureFromSwipe(page);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  expect(await page.evaluate(microphoneState)).toBe("ended");
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await captureFromSwipe(page);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
}

/** Keep pending capture visibly distinct from an active call and allow cancellation.
@param fixtures - Browser owned by the isolated realtime fixture.
*/
async function showsPendingCapture({ page }: { page: Page }) {
  await configureVoice();
  await page.addInitScript({ content: pendingPermission });
  await openVoice(page);
  await swipeVoice(page);
  const status = page.getByRole("status", { name: "Realtime voice starting" });

  await expect(status.getByText("Connecting voice…")).toHaveCSS("opacity", "1");
  await expect(status.locator('[data-slot="spinner"]')).toBeVisible();
  await expect(status.locator("canvas")).toHaveCSS("filter", "grayscale(1)");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toHaveCount(0);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
}

test("first swipe captures native audio despite a stalled spectrum and permits a clean retry", ({ page }) =>
  startsWithoutSpectrum(stalledSpectrum, { page }));
test("spectrum resume rejection does not prevent capture or retry", ({ page }) =>
  startsWithoutSpectrum(rejectedSpectrum, { page }));
test("pending microphone permission shows connecting instead of active voice", showsPendingCapture);
