import { type AdapterOptions, type Harness } from "../src/server/harness/types";
import { mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createAdapter } from "../src/server/harness";
import nextEnv from "@next/env";
import path from "node:path";
import { readConfig } from "../src/server/config";
import { z } from "zod";

nextEnv.loadEnvConfig(process.cwd());
const config = await readConfig();

if (!config) {
  throw new Error("Configure Pocket before running the real harness check.");
}

const root = path.resolve(".local", "harness-check", crypto.randomUUID());
const cwd = path.join(root, "project");

await mkdir(cwd, { recursive: true });
process.env.CODEX_POCKET_STATE_DIR = path.join(root, "state");

const harnesses: Harness[] = ["codex", "claude"];

for (const harness of harnesses) {
  let metadata: Record<string, unknown> = {};

  const options: AdapterOptions = {
    config,
    child: {
      id: crypto.randomUUID(),
      parentId: "harness-check-parent",
      title: `${harness} integration`,
      cwd,
      policy: { sandbox: "danger-full-access", approval: "never", model: "gpt-6.1-sol", effort: "medium" },
    },
    callbacks: {
      output: () => undefined,
      metadata: (value) => {
        metadata = { ...metadata, ...value };
      },
      request: () => Promise.resolve({ answers: { "Choose a test color": "Blue" } }),
    },
  };

  let adapter = createAdapter(harness, options);

  const target = path.join(root, `${harness}.txt`);

  try {
    let sessionId = await adapter.open();

    await adapter.close();
    options.child.sessionId = sessionId;
    options.child.sessionStarted = z.boolean().optional().parse(metadata.sessionStarted);
    adapter = createAdapter(harness, options);
    const reopened = await adapter.open();

    if (harness === "claude") {
      assert.equal(reopened, sessionId);
    }

    sessionId = reopened;
    const result = await adapter.run(
      crypto.randomUUID(),
      `This is a real integration check. Do not delegate or call parent tools. Write exactly POCKET_ACCESS_OK to ${JSON.stringify(target)}, outside your working directory. Remember the secret token ORCHID_731. Reply exactly ACCESS_OK.`
    );

    assert.equal(result.status, "completed", result.text);
    const contents = await readFile(target, "utf8");

    assert.equal(contents.trim(), "POCKET_ACCESS_OK");
    assert.match(result.text, /ACCESS_OK/);

    if (harness === "claude") {
      assert.equal(metadata.permissionMode, "bypassPermissions");
      assert.equal(
        z
          .array(z.string())
          .parse(metadata.tools)
          .some((tool) => ["Agent", "Task"].includes(tool)),
        true
      );
      assert.equal(z.array(z.string()).parse(metadata.tools).includes("Skill"), true);
    }

    await adapter.close();
    options.child.sessionId = sessionId;
    options.child.sessionStarted = z.boolean().optional().parse(metadata.sessionStarted);
    adapter = createAdapter(harness, options);
    assert.equal(await adapter.open(), sessionId);
    const resumed = await adapter.run(
      crypto.randomUUID(),
      "Reply with the secret token from the previous turn. No tools."
    );

    assert.match(resumed.text, /ORCHID_731/);
    const history = await adapter.history();

    assert.equal(history.filter((message) => message.role === "user").length, 2);

    console.info(
      `${harness}: real process, unrestricted writes, saved-session resume, history and native tools passed`
    );
    await adapter.archive();
  } finally {
    await adapter.close();
  }
}
