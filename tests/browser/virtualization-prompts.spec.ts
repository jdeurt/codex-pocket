import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";

const HISTORY_SIZE = 1000;

test("pending answer drafts survive new output and prepended history without submitting", async ({ page }) => {
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    turns: [
      {
        id: "pending-question",
        status: "interrupted",
        items: Array.from({ length: HISTORY_SIZE }, (_, index) => ({
          id: `before-${index}`,
          type: "agentMessage",
          text: `Fixture message ${index}`,
        })),
      },
    ],
    requests: [
      {
        id: "question-fixture",
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "choice", question: "Which fixture?" }] },
      },
    ],
  };
  const writes = await mount(page, state);
  const answer = page.getByRole("textbox", { name: "Your answer", exact: true });
  await answer.fill("Preserved answer draft");
  state.turns[0].items.push({ id: "after-question", type: "agentMessage", text: "Additional fixture output" });
  await publish(page, state);
  await expect(answer).toHaveValue("Preserved answer draft");
  state.turns[0].items.unshift({ id: "older-question", type: "agentMessage", text: "Earlier fixture history" });
  await publish(page, state);
  await expect(answer).toHaveValue("Preserved answer draft");
  expect(writes).toEqual([]);
});
