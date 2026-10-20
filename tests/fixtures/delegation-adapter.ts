import {
  type AdapterOptions,
  type Harness,
  type HarnessAdapter,
  type HarnessResult,
} from "../../src/server/harness/types";
import type { HostEvent } from "./delegation-protocol";

/**
Models native command completion, questions and confirmed exit gates without starting a model.
*/
export class SimulatedAdapter implements HarnessAdapter {
  private resolve?: (result: HarnessResult) => void;

  private reject?: (error: Error) => void;

  private closing?: Promise<void>;

  private releaseClose?: () => void;

  private closeGate?: Promise<void>;

  /**
  Binds real harness callbacks to this fake native process resource.
  @param options - Actual adapter contract with scoped child identity and callbacks.
  @param harness - Harness label recorded in process-start events.
  @param emit - Owned host IPC publisher for synthetic native lifecycle events.
  */
  constructor(
    private options: AdapterOptions,
    private harness: Harness,
    private emit: (event: HostEvent) => void
  ) {}

  /**
  Interrupts the fake command and publishes exit only after its configured close gate is released.
  @returns Completion of confirmed synthetic native process exit.
  */
  private async closeNative() {
    await this.interrupt();
    await this.closeGate;
    this.emit({ event: "exited", childId: this.options.child.id });
  }

  /**
  Returns the child's saved session identity or its stable synthetic initial identity.
  @returns Native session identity used by the real worker.
  */
  open() {
    return Promise.resolve(this.options.child.sessionId ?? `saved:${this.options.child.id}`);
  }

  /**
  Reserves command settlement and optionally holds native exit for capacity assertions.
  @param id - Persisted command identity claimed by the real worker.
  @param text - Assignment body or the explicit held-exit fixture command.
  @returns Native harness result after completion, failure or interruption.
  */
  run(id: string, text: string) {
    if (text === "hold-close") {
      this.closeGate = new Promise((resolve) => {
        this.releaseClose = resolve;
      });
    }

    return new Promise<HarnessResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.emit({ event: "started", id, childId: this.options.child.id, harness: this.harness, text });
    });
  }

  /**
  Settles the running fake command with a successful native result.
  */
  complete() {
    this.resolve?.({ status: "completed", text: "Simulated result" });
  }

  /**
  Rejects the fake command after send to exercise uncertain-delivery classification.
  */
  fail() {
    this.reject?.(new Error("Simulated disconnect after send"));
  }

  /**
  Routes a real harness question through durable parent mail and publishes answer or cancellation.
  @returns Completion of the question's resolved or cancelled lifecycle.
  */
  async ask() {
    try {
      const answer = await this.options.callbacks.request({
        id: "native-question",
        kind: "question",
        method: "AskUserQuestion",
        input: { question: "Color?" },
      });

      this.emit({ event: "answer", childId: this.options.child.id, answer });
    } catch (error) {
      this.emit({ event: "cancelled", childId: this.options.child.id, error: String(error) });
    }
  }

  /**
  Releases the configured native exit gate without claiming process exit prematurely.
  */
  release() {
    this.releaseClose?.();
  }

  /**
  Exposes this simulator's intentionally empty native saved-history contract.
  @returns Empty native harness message history.
  */
  history() {
    return Promise.resolve([]);
  }

  /**
  Settles a running fake command as interrupted before process cleanup.
  @returns Completion of synthetic interruption.
  */
  interrupt() {
    this.resolve?.({ status: "interrupted", text: "Closed" });

    return Promise.resolve();
  }

  /**
  Uses the same native interruption path for this simulator's archive operation.
  @returns Completion of synthetic archive interruption.
  */
  async archive() {
    await this.interrupt();
  }

  /**
  Shares one cleanup promise across competing worker and explicit-close callers.
  @returns Confirmed synthetic exit, held until any configured close gate is released.
  */
  close() {
    this.closing ??= this.closeNative();

    return this.closing;
  }
}
