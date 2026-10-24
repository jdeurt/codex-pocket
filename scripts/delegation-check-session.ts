import { type DelegationStore, delegations } from "../src/server/delegations";
import { access, readFile } from "node:fs/promises";
import { Bridge } from "../src/server/bridge";
import { CodexRpc } from "../src/server/rpc";
import { type Config } from "../src/server/config";
import { DelegationWorker } from "../src/server/delegation-worker";
import { type SidePocket } from "../src/server/delegation-data";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { string } from "../src/lib/protocol";
import { z } from "zod";

const CHECK_TIMEOUT_MS = 240_000;
const POLL_MS = 500;
const EXPECTED_CHILDREN = 2;
const EXPECTED_COMMANDS = 3;
const ACTIVE_CLOSE_TIMEOUT_MS = 30_000;
const LAST_INDEX = -1;
const processMetadataSchema = z.object({ pid: z.number() });

/**
Waits for a real native side effect or durable status with the existing bounded check interval.
@param isSatisfied - Native filesystem or durable-state readiness predicate.
@param label - Expected transition used in timeout diagnostics.
@returns Completion of the expected transition; timeout rejects.
*/
async function waitUntil(isSatisfied: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + ACTIVE_CLOSE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isSatisfied()) {
      return;
    }

    await setTimeout(POLL_MS);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

/**
Checks the actual child-created marker without treating a missing file as ready.
@param file - Private marker path selected by the active-close scenario.
@returns Whether the file is accessible.
*/
async function doesFileExist(file: string) {
  return (async () => {
    await access(file);

    return true;
  })().catch(() => {
    return false;
  });
}

/**
Requires the native process recorded by an already closed child to be absent.
@param metadata - Saved native harness metadata read after command completion.
*/
function verifyExit(metadata: string) {
  const native = processMetadataSchema.parse(JSON.parse(metadata));

  assert.throws(() => process.kill(native.pid, 0), { code: "ESRCH" });
}

/**
Owns the real parent, delegation worker and archive connections for the live workflow check.
*/
export class DelegationCheck {
  private parent: Bridge;
  private store: DelegationStore;
  private worker: DelegationWorker;

  /**
  Binds native parent and worker resources after the new test thread's environment is installed.
  @param config - Validated native configuration with the new thread and private working folder.
  @param root - Private integration root receiving child-written files and markers.
  */
  constructor(
    private config: Config,
    private root: string
  ) {
    this.parent = new Bridge();
    this.store = delegations();
    this.worker = new DelegationWorker(this.store, this.parent, config);
  }

  /**
  Waits for the parent's final reply and both real child processes to reach closed state.
  @returns Completion of the existing bounded native delegation workflow assertion.
  */
  private async waitForCompletion() {
    const deadline = Date.now() + CHECK_TIMEOUT_MS;

    let isFinished = false;

    while (Date.now() < deadline) {
      const isReply = this.parent.snapshot.turns
        .flatMap((turn) => turn.items)
        .some((item) => item.type === "agentMessage" && string(item.text).includes("DELEGATION_CHECK_OK"));
      const children = this.store.list(this.config.threadId);

      if (
        isReply &&
        !this.parent.snapshot.activeTurnId &&
        children.length === EXPECTED_CHILDREN &&
        children.every((child) => child.status === "closed")
      ) {
        isFinished = true;
        break;
      }

      await setTimeout(POLL_MS);
    }

    assert.equal(
      isFinished,
      true,
      JSON.stringify(this.store.list(this.config.threadId).map(({ title, status }) => ({ title, status })))
    );
  }

  /**
  Checks a completed child's real file operation, command history, report and native process exit.
  @param child - Canonical closed child record from the actual durable store.
  @returns Completion of persisted workflow and filesystem assertions.
  */
  private async verifyChild(child: SidePocket) {
    const contents = await readFile(path.join(this.root, `${child.harness}.txt`), "utf8");

    assert.equal(contents.trim(), "BLUE");
    assert.equal(this.store.queue.list(this.config.threadId, child.id).length, EXPECTED_COMMANDS);
    assert.equal(
      this.store.mail
        .history(this.config.threadId, child.id)
        .some((mail) => mail.kind === "message" && mail.payload.includes("RESUME_DONE ORCHID_731")),
      true
    );
    verifyExit(child.metadata);
  }

  /**
  Verifies all completed children before retaining their saved identities for the worker restart check.
  @returns Canonical child records captured before active-close scenarios.
  */
  private async verifyChildren() {
    const children = this.store.list(this.config.threadId);

    for (const child of children) {
      await this.verifyChild(child);
    }

    return children;
  }

  /**
  Closes an actually running child and checks process exit before asserting its command was cancelled.
  @param child - Canonical child whose original saved session identity must survive closure.
  @param late - Private file that must never be written after interruption.
  @returns Completion of confirmed-close and persisted identity assertions.
  */
  private async confirmClose(child: SidePocket, late: string) {
    const metadata = processMetadataSchema.parse(JSON.parse(this.store.get(this.config.threadId, child.id).metadata));

    this.store.closeChild(this.config.threadId, child.id);
    await waitUntil(
      () => Promise.resolve(this.store.get(this.config.threadId, child.id).status === "closed"),
      "process closure"
    );
    assert.throws(() => process.kill(metadata.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(late), { code: "ENOENT" });
    assert.equal(this.store.queue.list(this.config.threadId, child.id).at(LAST_INDEX)?.status, "cancelled");
    assert.equal(this.store.get(this.config.threadId, child.id).sessionId, child.sessionId);
  }

  /**
  Resumes one saved child and interrupts its real foreground command after its start marker appears.
  @param child - Canonical saved child selected from this parent's durable store.
  @returns Completion of native start-marker and active-close checks.
  */
  private async activeClose(child: SidePocket) {
    const marker = path.join(this.root, `${child.harness}-started`);
    const late = path.join(this.root, `${child.harness}-late`);

    this.store.resume(this.config.threadId, child.id);
    this.store.queue.send(
      this.config.threadId,
      child.id,
      "active-close",
      `Run this shell command in the foreground: printf STARTED > '${marker}'; sleep 30; printf LATE > '${late}'. This tests interrupting an active command. Use no other tools and send no parent messages.`
    );
    await waitUntil(() => doesFileExist(marker), "active child command");
    await this.confirmClose(child, late);
  }

  /**
  Checks native interruption and closure for both real harnesses after their completed workflows.
  @returns Completion of all active-close scenarios.
  */
  private async verifyActiveClose() {
    for (const child of this.store.list(this.config.threadId)) {
      await this.activeClose(child);
    }
  }

  /**
  Replaces the actual delegation worker and verifies durable native session identities survive.
  @returns Completion of child workflow, active-close and worker restart assertions.
  */
  private async persistedRestart() {
    const children = await this.verifyChildren();

    await this.verifyActiveClose();
    await this.worker.stop();
    this.worker = new DelegationWorker(this.store, this.parent, this.config);
    this.worker.start();
    await this.worker.tick();
    assert.deepEqual(
      this.store.list(this.config.threadId).map((child) => child.sessionId),
      children.map((child) => child.sessionId)
    );
    console.info(
      "Real Codex parent delegated to Codex and Claude, received child questions, answered, closed processes, resumed saved sessions and received completion. Restart preserved identities without duplicate work."
    );
  }

  /**
  Sends the existing real delegation instructions and waits for the parent's completed workflow.
  @returns Completion of the real native parent and child scenarios.
  */
  private async workflow() {
    await this.parent.ensureConnected();
    this.worker.start();
    await this.parent.send(
      crypto.randomUUID(),
      `Run this real Side Pocket integration check using Pocket's MCP tools.
Create exactly two Side Pockets: one with harness codex and title Codex check, one with harness claude and title Claude check. Give each a stable creation key.
First assignment for each child: remember token ORCHID_731, call message_parent with the question "QUESTION_READY: Which color should I write?", then finish its turn awaiting a follow-up. This specifically tests message_parent. Let children use that tool normally.
When a child's QUESTION_READY arrives, answer using side_pocket_send: write exactly BLUE to ${JSON.stringify(this.root)}/<harness>.txt (codex.txt or claude.txt), then call message_parent with "WRITE_DONE". Use stable send keys. Each child must do its own file operation.
When its WRITE_DONE arrives, close the child with side_pocket_close, resume the same ID with side_pocket_resume, then send one final follow-up asking it to recall ORCHID_731 and report "RESUME_DONE ORCHID_731" via message_parent. When that report arrives, close that child again.
Use side_pocket_list/get to track child IDs and pending work. Incoming child reports wake you automatically; yield between reports instead of polling. Do not create extra children or duplicate messages.
After both children complete this workflow and are closed, reply exactly DELEGATION_CHECK_OK. Do not use native subagents for this check.`
    );
    await this.waitForCompletion();
    await this.persistedRestart();
  }

  /**
  Archives this parent's saved Codex children using the already owned cleanup connection.
  @param cleanup - Connected bare native transport used only for archival.
  @returns Completion of native child archive acknowledgements.
  */
  private async archiveChildren(cleanup: CodexRpc) {
    for (const child of this.store.list(this.config.threadId)) {
      if (child.harness === "codex" && child.sessionId) {
        await cleanup.request("thread/archive", { threadId: child.sessionId });
      }
    }
  }

  /**
  Archives the created parent and its saved Codex children and joins the native cleanup process exit.
  @returns Completion of parent/child archival and cleanup transport shutdown.
  */
  private async archive() {
    const cleanup = new CodexRpc();

    await (async () => {
      await cleanup.connect(this.config, "bare");
      await cleanup.request("thread/archive", { threadId: this.config.threadId });
      await this.archiveChildren(cleanup);
    })().finally(async () => {
      await cleanup.shutdown();
    });
  }

  /**
  Closes the parent and archives its owned native sessions even when worker shutdown rejects.
  @returns Completion of worker, parent and archive connection cleanup.
  */
  private async cleanup() {
    await (async () => this.worker.stop())().finally(async () => {
      this.parent.close();
      await this.archive();
    });
  }

  /**
  Runs the explicitly selected live delegation check with unconditional native cleanup.
  @returns Completion of the workflow and native cleanup; failures propagate.
  */
  async run() {
    await (async () => this.workflow())().finally(async () => {
      await this.cleanup();
    });
  }
}
