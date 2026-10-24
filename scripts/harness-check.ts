import { t as captureResult } from "try";
import {
  type AdapterOptions,
  type Harness,
  type HarnessAdapter,
  type HarnessResult,
} from "../src/server/harness/types";
import { type Config, readConfig } from "../src/server/config";
import { mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createAdapter } from "../src/server/harness";
import nextEnv from "@next/env";
import path from "node:path";
import { z } from "zod";

const metadataSchema = z.looseObject({
  sessionStarted: z.boolean().optional(),
  permissionMode: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

/**
Owns the real harness connection across initial open, saved-session reopen and archive checks.
*/
class HarnessCheck {
  private metadata: z.infer<typeof metadataSchema> = {};
  private options: AdapterOptions;
  private adapter: HarnessAdapter;
  private target: string;

  /**
  Creates one native adapter and its explicit test policy without opening a model session.
  @param harness - Native harness selected for this check.
  @param config - Existing configured native executable and connection options.
  @param root - Private integration state root.
  @param cwd - Private working folder, distinct from the write target.
  */
  constructor(
    private harness: Harness,
    config: Config,
    root: string,
    cwd: string
  ) {
    this.options = {
      config,
      child: {
        id: crypto.randomUUID(),
        parentId: "harness-check-parent",
        title: `${harness} integration`,
        cwd,
        policy: { sandbox: "danger-full-access", approval: "never", model: "gpt-6.1-sol", effort: "medium" },
      },
      callbacks: {
        output: () => {
          // This check asserts completed native results; streamed output has no consumer.
        },
        metadata: (value) => {
          this.metadata = metadataSchema.parse({ ...this.metadata, ...value });
        },
        request: () => Promise.resolve({ answers: { "Choose a test color": "Blue" } }),
      },
    };
    this.adapter = createAdapter(harness, this.options);
    this.target = path.join(root, `${harness}.txt`);
  }

  /**
  Closes the current native process before creating a fresh adapter for the saved identity.
  @param sessionId - Previously acknowledged native session identity.
  @returns Identity acknowledged by the reopened native adapter.
  */
  private async reopen(sessionId: string) {
    await this.adapter.close();
    this.options.child.sessionId = sessionId;
    this.options.child.sessionStarted = this.metadata.sessionStarted;
    this.adapter = createAdapter(this.harness, this.options);

    return await this.adapter.open();
  }

  /**
  Checks Claude's normalized native permission mode and advertised tool capabilities.
  */
  private verifyNativeTools() {
    if (this.harness !== "claude") {
      return;
    }

    assert.equal(this.metadata.permissionMode, "bypassPermissions");
    assert.equal(
      this.metadata.tools?.some((tool) => ["Agent", "Task"].includes(tool)),
      true
    );
    assert.equal(this.metadata.tools.includes("Skill"), true);
  }

  /**
  Checks the actual file written outside the working folder and its corresponding native reply.
  @param result - Acknowledged native command result.
  @returns Completion of filesystem, reply and native capability assertions.
  */
  private async verifyWrite(result: HarnessResult) {
    const contents = await readFile(this.target, "utf8");

    assert.equal(contents.trim(), "POCKET_ACCESS_OK");
    assert.match(result.text, /ACCESS_OK/);
    this.verifyNativeTools();
  }

  /**
  Sends the existing access check and verifies its real native and filesystem outcomes.
  @returns Completion of the native write command and access assertions.
  */
  private async writeCheck() {
    const result = await this.adapter.run(
      crypto.randomUUID(),
      `This is a real integration check. Do not delegate or call parent tools. Write exactly POCKET_ACCESS_OK to ${JSON.stringify(this.target)}, outside your working directory. Remember the secret token ORCHID_731. Reply exactly ACCESS_OK.`
    );

    assert.equal(result.status, "completed", result.text);
    await this.verifyWrite(result);
  }

  /**
  Checks complete native saved history before archiving this explicit test session.
  @returns Completion of native history assertions and archive acknowledgement.
  */
  private async verifyHistory() {
    const history = await this.adapter.history();

    assert.equal(history.filter((message) => message.role === "user").length, 2);
    console.info(
      `${this.harness}: real process, unrestricted writes, saved-session resume, history and native tools passed`
    );
    await this.adapter.archive();
  }

  /**
  Requires the reopened native session to remember the earlier token without using tools.
  @returns Completion of memory, history and archival checks.
  */
  private async rememberedToken() {
    const resumed = await this.adapter.run(
      crypto.randomUUID(),
      "Reply with the secret token from the previous turn. No tools."
    );

    assert.match(resumed.text, /ORCHID_731/);
    await this.verifyHistory();
  }

  /**
  Executes the existing initial-open, write, saved-session and memory sequence in order.
  @returns Completion of this harness's real integration check.
  */
  private async execute() {
    const sessionId = await this.adapter.open();
    const reopened = await this.reopen(sessionId);

    if (this.harness === "claude") {
      assert.equal(reopened, sessionId);
    }

    await this.writeCheck();
    assert.equal(await this.reopen(reopened), reopened);
    await this.rememberedToken();
  }

  /**
  Runs one explicitly selected live harness check and closes the currently owned adapter on every outcome.
  @returns Completion of the check and native cleanup; failures propagate.
  */
  async run() {
    const completed = await captureResult(this.execute());

    await this.adapter.close();

    if (!completed.ok) {
      throw completed.error;
    }
  }
}

/**
Checks both real native harnesses against the already prepared private project.
@param config - Existing configured native executable and connection options.
@param root - Private state root receiving the out-of-folder write targets.
@param cwd - Private working folder.
@returns Completion of both native harness checks.
*/
async function checkHarnesses(config: Config, root: string, cwd: string) {
  const harnesses: Harness[] = ["codex", "claude"];

  for (const harness of harnesses) {
    const check = new HarnessCheck(harness, config, root, cwd);

    await check.run();
  }
}

/**
Creates private state before opening the explicitly selected native harnesses.
@param config - Existing configured native executable and connection options.
@returns Completion of private setup and the real harness checks.
*/
async function privateProject(config: Config) {
  const root = path.resolve(".local", "harness-check", crypto.randomUUID());
  const cwd = path.join(root, "project");

  await mkdir(cwd, { recursive: true });
  process.env.CODEX_POCKET_STATE_DIR = path.join(root, "state");
  await checkHarnesses(config, root, cwd);
}

/**
Requires explicit existing Pocket configuration before starting real native checks.
@returns Completion of the requested live harness check; missing configuration rejects.
*/
async function main() {
  const config = await readConfig();

  if (!config) {
    throw new Error("Configure Pocket before running the real harness check.");
  }

  await privateProject(config);
}

nextEnv.loadEnvConfig(process.cwd());
await main();
