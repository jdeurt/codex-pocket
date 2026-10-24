import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ESLint } from "eslint";
import { createConfig } from "../../eslint.config";
import { t as attempt } from "try";
import { createOperation } from "../../src/services/operation";

await test("error policy bans try statements in JavaScript and TypeScript while permitting Promise chains", async () => {
  const lint = new ESLint({ overrideConfigFile: true, overrideConfig: createConfig() });

  for (const extension of ["ts", "js"]) {
    const [blocked] = await lint.lintText('try { JSON.parse("bad"); } catch (error) { console.error(error); }', {
      filePath: `src/error-policy-example.${extension}`,
    });

    assert.equal(
      blocked.messages.some((message) => message.ruleId === "no-restricted-syntax"),
      true
    );
    const [allowed] = await lint.lintText(
      'Promise.resolve("ok").then(console.info).catch(console.error).finally(async () => { await Promise.resolve(); });',
      { filePath: `src/error-policy-example.${extension}` }
    );

    assert.deepEqual(
      allowed.messages.filter((message) =>
        ["no-restricted-syntax", "unicorn/prefer-await", "unicorn/no-async-promise-finally"].includes(
          message.ruleId ?? ""
        )
      ),
      []
    );
  }
});

await test("Result handling exposes parse failures and mutation cleanup releases the busy lock", async () => {
  const result = attempt(JSON.parse, "bad");

  assert.equal(result.ok, false);
  const operation = createOperation();
  const outcome = await operation.run(() => {
    throw new Error("Synchronous invocation failed.");
  }, "Fallback");

  assert.equal(outcome.ok, false);
  assert.equal(operation.store.getState().busy, false);
  assert.equal(operation.store.getState().error, "Synchronous invocation failed.");
  const retry = await operation.run(() => Promise.resolve("recovered"), "Fallback");

  assert.deepEqual(retry, { ok: true, value: "recovered" });
  assert.equal(operation.store.getState().busy, false);
});

await test("service worker keeps visible notification fallbacks when push JSON fails", async () => {
  const source = await readFile("public/sw.js", "utf8");
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: string[] = [];
  const pending: Promise<void>[] = [];

  runInNewContext(source, {
    ServiceWorkerGlobalScope: { [Symbol.hasInstance]: () => true },
    addEventListener: (name: string, listener: (event: unknown) => void) => handlers.set(name, listener),
    registration: {
      showNotification: (title: string) => {
        shown.push(title);

        return Promise.resolve();
      },
    },
  });

  handlers.get("push")?.({
    data: {
      json: () => {
        throw new SyntaxError("Invalid push JSON");
      },
    },
    waitUntil: (work: Promise<void>) => {
      pending.push(work);
    },
  });
  handlers.get("push")?.({
    data: { json: () => ({ title: "Work completed" }) },
    waitUntil: (work: Promise<void>) => {
      pending.push(work);
    },
  });
  await Promise.all(pending);
  assert.deepEqual(new Set(shown), new Set(["Pocket", "Work completed"]));
});
