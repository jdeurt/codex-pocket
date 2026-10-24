import { ContentReveals } from "../runtime/content-reveal";
import { voiceState } from "../state/voice";
import { threadState, type ThreadState } from "../state/thread";
import { observable } from "../runtime/stores";
import { t } from "try";
import { type ClientBootstrap } from "../state/bootstrap";
import { canReloadPocket, scopedPocketUrl } from "../state/pocket";
import { DraftController } from "./draft";
import { AttachmentController } from "./attachments";
import { Resources } from "./resources";
import { VoiceController } from "./voice";
import { DeliveryController } from "./delivery";
import { SettingsController } from "./settings";
import { PocketsController } from "./pockets";
import { Operation } from "./operation";
import { post } from "../runtime/client-api";
import { NotificationController } from "./notifications";
import { connectThread } from "./thread";

/** Register the production worker at the browser boundary.
@returns Native registration completion.
*/
function registerServiceWorker() {
  return navigator.serviceWorker.register("/sw.js");
}

/**
Register the production worker and report failures without rejecting the provider lifecycle.
*/
async function registerWorker() {
  const registered = await t(registerServiceWorker);

  if (!registered.ok) {
    console.error(registered.error);
  }
}

/**
Explicit runtime root for one rendered Pocket; never shared between SSR requests or providers.
*/
export class PocketClient {
  private readonly pocketId: string;
  private readonly operations = new Map<string, Operation>();
  private cleanups: (() => void)[] = [];
  private recovered: string | undefined;

  /**
  Recover an unacknowledged attachment send without overwriting current typing.
  */
  private recoverDraft = () => {
    const pending = this.attachments.store.getState().draft.pending;

    if (!pending || this.recovered === pending.id) {
      return;
    }

    this.recovered = pending.id;

    if (!this.draft.store.getState().text && !this.delivery.store.getState().busy) {
      this.draft.setText(pending.text);
    }
  };

  /** Release media when its owning conversation disconnects.
  @param current - Published thread projection.
  */
  private threadChanged = (current: ThreadState) => {
    if ((!current.connected || current.state.connection !== "connected") && this.voice.getState().state !== "idle") {
      void this.realtime.stop();
    }
  };

  /**
  Release every mounted subscription and begin media shutdown.
  */
  private disconnect = () => {
    for (const stop of this.cleanups) {
      stop();
    }

    this.cleanups = [];
    void this.realtime.stop();
  };

  readonly reveals = new ContentReveals();
  readonly thread;
  readonly voice;
  readonly draft;
  readonly attachments = new AttachmentController();
  readonly resources;
  readonly realtime;
  readonly delivery;
  readonly settings;
  readonly pockets;
  readonly notifications = new NotificationController();

  /** Resolve an endpoint for this owner's fixed Pocket identity.
  @param url - Endpoint path.
  @returns Explicitly scoped endpoint.
  */
  scope = (url: string) => scopedPocketUrl(this.pocketId, url);

  /** Read durable/runtime status and apply the pure reload decision.
  @returns Whether navigation can preserve ongoing work.
  */
  canReload = () =>
    canReloadPocket(
      this.delivery.store.getState().busy,
      this.voice.getState().state,
      this.thread.getState().state.queue,
      this.draft.isSaved(),
      this.attachments.canReload()
    );

  /** Retain one operation lock per explicitly named UI action.
  @param id - Operation identity.
  @returns Shared runtime operation owner.
  */
  operation = (id: string) => {
    const operation = this.operations.get(id) ?? new Operation();

    this.operations.set(id, operation);

    return operation;
  };

  /** Submit a response to a pending native question.
  @param id - Native request identity.
  @param result - User-provided response.
  */
  answer = async (id: string | number, result: unknown) => {
    await this.operation(`answer:${String(id)}`).run(
      post,
      "Couldn't send your answer.",
      "",
      this.scope("/api/answers"),
      { id, result }
    );
  };

  /** Start browser services after hydration.
  @returns Cleanup for this provider lifetime.
  */
  connect = () => {
    this.cleanups = [
      this.attachments.store.subscribe(this.recoverDraft),
      this.thread.subscribe(this.threadChanged),
      this.notifications.connect(),
      this.draft.connect(),
      connectThread(this.thread, this.scope("/api/events")),
    ];

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void registerWorker();
    }

    return this.disconnect;
  };

  /** Allocate state and dependency owners without opening sockets or reading browser storage.
  @param initial - Matching server/client bootstrap for this Pocket.
  */
  constructor(initial: ClientBootstrap) {
    this.pocketId = initial.pocketId;
    this.thread = observable(threadState(initial.snapshot));
    this.voice = observable(voiceState(initial.captions));
    this.draft = new DraftController(initial.pocketId);
    this.resources = new Resources(this.scope, initial.resources);
    this.realtime = new VoiceController(this.voice, this.scope("/api/realtime"), this.scope("/api/realtime/events"));
    this.delivery = new DeliveryController(
      this.thread,
      this.voice,
      this.draft,
      this.attachments,
      this.scope("/api/messages")
    );
    this.settings = new SettingsController(this.resources, this.scope("/api/settings"));
    this.pockets = new PocketsController(this.resources, initial.pocketId, this.scope("/api/pockets"));
  }
}
