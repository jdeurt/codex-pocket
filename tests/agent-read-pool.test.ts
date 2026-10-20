import { agentRead, promoteAgentRead } from "../src/server/agent-read-pool";
import assert from "node:assert/strict";
import test from "node:test";

const PREVIEWS = 4;

await test("a selected transcript starts while background previews are held", async () => {
  const gate = Promise.withResolvers<undefined>();
  const started: string[] = [];
  const previews = Array.from({ length: PREVIEWS }, (_, index) =>
    agentRead(async () => {
      started.push(`preview-${String(index)}`);
      await gate.promise;
    }, 1)
  );
  const selected = agentRead(async () => {
    started.push("selected");
    await gate.promise;
  });

  try {
    assert.ok(started.includes("selected"), "Background previews must leave capacity for the selected transcript");
    assert.equal(started.length, PREVIEWS);
  } finally {
    gate.resolve(undefined);
    await Promise.all([...previews, selected]);
  }
});

await test("selecting an already queued background hydration promotes that same read", async () => {
  const gate = Promise.withResolvers<undefined>();
  const started: number[] = [];
  const reads = Array.from({ length: PREVIEWS }, (_, index) =>
    agentRead(
      async () => {
        started.push(index);
        await gate.promise;
      },
      1,
      String(index)
    )
  );

  try {
    assert.equal(started.length, PREVIEWS - 1);
    promoteAgentRead(String(PREVIEWS - 1));
    assert.equal(started.length, PREVIEWS);
    assert.equal(new Set(started).size, PREVIEWS);
  } finally {
    gate.resolve(undefined);
    await Promise.all(reads);
  }
});

await test("failed reads release every pool slot for later reads", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: PREVIEWS }, () => agentRead(() => Promise.reject(new Error("Native reader unavailable"))))
  );

  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(await agentRead(() => Promise.resolve("recovered")), "recovered");
});
