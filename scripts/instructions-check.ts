import { type Config, configSchema } from "../src/server/config";
import { type Thread, initialSnapshot, object } from "../src/lib/protocol";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { pocketInstructions, resumePocket } from "../src/server/pocket-runtime";
import { CodexRpc } from "../src/server/rpc";
import { RpcNotificationEvent } from "../src/server/rpc-events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadHistory } from "../src/server/history";
import path from "node:path";
import { readInstructionRollout } from "./instruction-rollout";
import { seedThread } from "./seed-thread";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const MARKER = "POCKET_NATIVE_PROMPT";

interface AuditResult {
  stage: string;
  marker: string;
  baseHash: string;
  promptCopies: number;
}

/**
Owns native instruction-audit connections, saved thread identity and cross-stage evidence.
*/
class InstructionCheck {
  private config: Config;
  private rpc: CodexRpc;
  private thread?: Thread;
  private originalBase?: string;
  private instructions: string;
  private results: AuditResult[] = [];

  /**
  Composes runtime instructions and creates the bootstrap connection after private state is installed.
  @param directory - Private audit root receiving captured results.
  @param project - Private native working folder.
  */
  constructor(
    private directory: string,
    private project: string
  ) {
    const existing = `The configured integration marker is ${MARKER}. When asked for the configured integration marker, reply exactly ${MARKER}.`;

    this.instructions = pocketInstructions(existing);
    assert.ok(this.instructions.startsWith(existing + "\n\n"));
    this.config = configSchema.parse({
      threadId: "bootstrap",
      cwd: project,
      codexBinary: process.env.CODEX_BINARY ?? "codex",
      serverArgs: [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        `developer_instructions=${JSON.stringify(existing)}`,
      ],
    });
    this.rpc = new CodexRpc();
  }

  /**
  Captures completed native assistant text only while the existing marker query runs.
  @returns Native assistant replies observed during this one marker turn.
  */
  private async markerReplies() {
    const replies: string[] = [];
    const listener = (event: Event) => {
      const notification = event instanceof RpcNotificationEvent ? event.notification : undefined;
      const item = object(notification?.params.item);

      if (notification?.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
        replies.push(item.text);
      }
    };

    this.rpc.addEventListener("event", listener);

    await seedThread(
      this.rpc,
      this.config.threadId,
      "Reply with the configured integration marker only. Do not use tools."
    ).finally(() => {
      this.rpc.removeEventListener("event", listener);
    });

    return replies;
  }

  /**
  Confirms the real visible history does not expose runtime developer instructions to the phone.
  @returns Completion of actual native history loading and phone-projection assertion.
  */
  private async verifyPhoneHistory() {
    const turns = await loadHistory(this.rpc, { id: this.config.threadId, turns: [] });
    const phone = visibleSnapshot({ ...initialSnapshot, connection: "connected", turns });

    assert.equal(JSON.stringify(phone).includes("Pocket displays image-view"), false);
  }

  /**
  Records verified native base identity and prompt multiplicity for one lifecycle stage.
  @param stage - Human-readable lifecycle stage checked by the native audit.
  @param base - Verified unchanged native base instruction text.
  @param promptCopies - Verified count of the composed Pocket developer prompt.
  */
  private record(stage: string, base: string, promptCopies: number) {
    const result = { stage, marker: MARKER, baseHash: createHash("sha256").update(base).digest("hex"), promptCopies };

    this.results.push(result);
    console.log(JSON.stringify(result));
  }

  /**
  Checks the freshly read saved native instructions and then the actual phone projection.
  @param stage - Native lifecycle stage being audited.
  @param filename - Validated native saved-session path.
  @returns Completion of unchanged-base, single-prompt and visible-history assertions.
  */
  private async verifyRollout(stage: string, filename: string) {
    const { base, developerTexts } = await readInstructionRollout(filename);
    const promptCopies = developerTexts.filter((text) => text.includes(this.instructions)).length;

    assert.ok(base.length > 0);
    assert.equal(base.includes("You are Pocket"), false);
    this.originalBase ??= base;
    assert.equal(base, this.originalBase);
    assert.equal(promptCopies, 1);
    await this.verifyPhoneHistory();
    this.record(stage, base, promptCopies);
  }

  /**
  Queries the existing marker and audits the corresponding saved native instructions.
  @param stage - Native lifecycle stage being audited.
  @param filename - Validated native saved-session path.
  @returns Completion of the exact marker reply and persisted instruction assertions.
  */
  private async check(stage: string, filename: string) {
    const replies = await this.markerReplies();

    assert.deepEqual(replies, [MARKER]);
    await this.verifyRollout(stage, filename);
  }

  /**
  Requires the actual app-server's saved-session file path once before audit stages reuse it.
  @param thread - Canonical native thread acknowledged by the real app-server.
  @returns Native saved-session path; missing or non-text paths fail the existing assertions.
  */
  private savedPath(thread: Thread) {
    assert.ok(thread);
    assert.equal(typeof thread.path, "string");
    assert.ok(typeof thread.path === "string");

    return thread.path;
  }

  /**
  Joins the old child exit before connecting a fresh native transport to the saved thread.
  @returns Completion of native reconnect and runtime Pocket resume instructions.
  */
  private async reconnect() {
    await this.rpc.shutdown();
    this.rpc = new CodexRpc();
    await this.rpc.connect(this.config);
    await resumePocket(this.rpc, this.config);
  }

  /**
  Audits both initial turns and both fresh-process reconnects without creating a prompt cache file.
  @param thread - Newly acknowledged native thread, retained separately for cleanup if validation fails.
  @returns Completion of all four instruction stages and private evidence persistence.
  */
  private async stages(thread: Thread) {
    const filename = this.savedPath(thread);

    await this.check("initial Pocket turn", filename);
    await this.check("next turn", filename);
    await this.reconnect();
    await this.check("fresh process resume", filename);
    await this.reconnect();
    await this.check("second reconnect", filename);
    await assert.rejects(readFile(path.join(this.directory, "state", "instructions.json")), { code: "ENOENT" });
    await writeFile(
      path.join(this.directory, "results.json"),
      JSON.stringify({ threadId: thread.id, results: this.results }, undefined, 2) + "\n"
    );
  }

  /**
  Creates the actual native thread and captures its identity before any saved-path validation can fail.
  @returns Completion of the native instruction audit stages.
  */
  private async createThread() {
    const started = await this.rpc.request("thread/start", {
      cwd: this.project,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: this.instructions,
    });

    this.thread = started.thread;
    this.config = { ...this.config, threadId: started.thread.id };
    await this.stages(started.thread);
  }

  /**
  Reconnects only when necessary to archive the native thread owned by this check.
  @param thread - Acknowledged native test thread retained even if a later stage failed.
  @returns Completion of native archive acknowledgement.
  */
  private async archive(thread: Thread) {
    if (!this.rpc.running) {
      this.rpc = new CodexRpc();
      await this.rpc.connect(this.config);
    }

    await this.rpc.request("thread/archive", { threadId: thread.id });
  }

  /**
  Archives an acknowledged test thread while leaving failed bootstrap attempts without a fabricated identity.
  @returns Completion of any required native archival.
  */
  private async archiveIfCreated() {
    if (this.thread) {
      await this.archive(this.thread);
    }
  }

  /**
  Joins the owned native process even when archival fails.
  @returns Completion of native archival and transport shutdown.
  */
  private async cleanup() {
    await (async () => this.archiveIfCreated())().finally(async () => {
      await this.rpc.shutdown();
    });
  }

  /**
  Runs the explicitly selected native instruction audit with unconditional process cleanup.
  @returns Completion of all audit stages and native cleanup; failures propagate.
  */
  async run() {
    await (async () => {
      await this.rpc.connect(this.config);
      await this.createThread();
    })().finally(async () => {
      await this.cleanup();
    });
  }
}

/**
Creates a fresh private native project before constructing the instruction-audit resource.
@returns Completion of private setup and the explicitly requested live instruction audit.
*/
async function privateProject() {
  const directory = await mkdtemp(path.resolve(".local", "instructions-check-"));
  const project = path.join(directory, "project");

  await mkdir(project);
  process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "state");
  await new InstructionCheck(directory, project).run();
}

await mkdir(".local", { recursive: true });
await privateProject();
