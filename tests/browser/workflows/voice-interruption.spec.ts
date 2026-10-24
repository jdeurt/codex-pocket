import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import {
  configureVoice,
  installRealtimePeer,
  openVoice,
  providerAction,
  startVoice,
} from "../../fixtures/realtime-browser";
import { dataSchema } from "../../../src/lib/protocol";

/**
The provider owns WebRTC interruption; the browser must not run a second truncation path.
*/
test("new speech uses the existing peer without browser audio commands and permits text continuation", async ({
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
  await configureVoice({ transcript: "First spoken request.", replyText: "First reply." });
  await installRealtimePeer(page);
  await openVoice(page);
  await startVoice(page);
  await providerAction("speech");
  await expect(page.getByText("First reply.", { exact: true })).toBeVisible();
  await configureVoice({ transcript: "Actually, change that.", replyText: "Understood." });
  await providerAction("speech");
  await expect(page.getByText("Understood.", { exact: true })).toBeVisible();
  expect(commands).toEqual(["start"]);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Continue in text.");
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();
  expect(commands).toEqual(["start", "stop"]);
});
