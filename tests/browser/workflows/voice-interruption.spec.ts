/* eslint-disable jsdoc/require-jsdoc -- Observe real Web Audio playback and the provider exchange during a complete browser interruption/recovery journey. */
import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../../src/lib/protocol";
import path from "node:path";

const directory = path.resolve(".local/realtime-fixture");
const INTERRUPTED_AUDIO_MS = 500;

test("speaking during playback stops queued browser audio, truncates heard output and allows text continuation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class ObservedAudioContext extends AudioContext {
      override createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        const stop = source.stop.bind(source);
        const record = (kind: string) => {
          if (!source.buffer?.getChannelData(0).some((sample) => sample !== 0)) {
            return;
          }

          const key = `pocket-interruption-${kind}`;
          const previous = Number(globalThis.sessionStorage.getItem(key) ?? "0");

          globalThis.sessionStorage.setItem(key, String(previous + 1));
        };

        source.start = (...args) => {
          record("started");
          start(...args);
        };
        source.stop = (...args) => {
          record("stopped");
          stop(...args);
        };
        source.addEventListener("ended", () => {
          record("ended");
        });

        return source;
      }
    }

    Object.defineProperty(globalThis, "AudioContext", { value: ObservedAudioContext });
  });
  await writeFile(path.join(directory, "control.json"), JSON.stringify({ transcript: "Hello Pocket.", bargeIn: true }));
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("And preserve my follow-up.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Hello", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => globalThis.sessionStorage.getItem("pocket-interruption-ended")))
    .toBe("2");
  expect(await page.evaluate(() => globalThis.sessionStorage.getItem("pocket-interruption-stopped"))).toBe("1");
  expect(await page.evaluate(() => globalThis.sessionStorage.getItem("pocket-interruption-started"))).toBe("2");
  const log = await readFile(path.join(directory, "provider.jsonl"), "utf8");
  const truncations = log
    .trim()
    .split("\n")
    .map((line) => dataSchema.parse(JSON.parse(line)))
    .filter((event) => event.method === "provider/realtime/truncate");

  expect(truncations).toHaveLength(1);
  expect(truncations[0]).toMatchObject({ type: "conversation.item.truncate", content_index: 0 });
  expect(String(truncations[0].item_id)).toMatch(/-reply$/);
  expect(truncations[0].audio_end_ms).toBeGreaterThan(0);
  expect(truncations[0].audio_end_ms).toBeLessThan(INTERRUPTED_AUDIO_MS);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Continue after interrupting voice.");
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText("Continue after interrupting voice.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();
});
