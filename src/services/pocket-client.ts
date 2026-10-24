import { type ClientBootstrap } from "../state/bootstrap";
import { createThreadStore } from "../state/thread";
import { createVoiceStore } from "../state/voice";
import { createDraftController } from "./draft";
import { createAttachmentController } from "./attachments";
import { createResources } from "./resources";
import { createVoiceController } from "./voice";
import { createDeliveryController } from "./delivery";
import { createSettingsController } from "./settings";
import { createPocketsController } from "./pockets";
import { createOperation } from "./operation";
import { post } from "../lib/client-api";
import { createNotificationController } from "./notifications";
import { connectThread } from "./thread";

/** Create one request/tab's state owners without opening sockets or accessing browser storage.
@param initial - Serialized public data loaded by the server for the selected Pocket.
@returns Separate stores and service controllers with an explicit mounted lifetime.
*/
export function createPocketClient(initial: ClientBootstrap) {
  const scope = (url: string) =>
    initial.pocketId === "main" || /[?&]pocket=/.test(url)
      ? url
      : `${url}${url.includes("?") ? "&" : "?"}pocket=${encodeURIComponent(initial.pocketId)}`;
  const thread = createThreadStore(initial.snapshot);
  const voice = createVoiceStore(initial.captions);
  const draft = createDraftController(initial.pocketId);
  const attachments = createAttachmentController();
  const resources = createResources(scope, initial.resources);
  const realtime = createVoiceController(voice, scope("/api/realtime"), scope("/api/realtime/events"));

  const delivery = createDeliveryController(thread, voice, draft, attachments, scope("/api/messages"));

  const settings = createSettingsController(resources, scope("/api/settings"));
  const pockets = createPocketsController(resources, initial.pocketId, scope("/api/pockets"));
  const notifications = createNotificationController();
  const operations = new Map<string, ReturnType<typeof createOperation>>();

  let recovered: string | undefined;

  const recoverDraft = () => {
    const pending = attachments.store.getState().draft.pending;

    if (!pending || recovered === pending.id) {
      return;
    }

    recovered = pending.id;

    if (!draft.store.getState().text && !delivery.store.getState().busy) {
      draft.setText(pending.text);
    }
  };
  const canReload = () =>
    !delivery.store.getState().busy &&
    voice.getState().state === "idle" &&
    thread.getState().state.queue.every((message) => message.status !== "unknown" && message.status !== "sending") &&
    draft.isSaved() &&
    attachments.canReload();

  return {
    canReload,
    notifications,
    settings,
    pockets,
    operation: (id: string) => {
      const operation = operations.get(id) ?? createOperation();

      operations.set(id, operation);

      return operation;
    },
    answer: async (id: string | number, result: unknown) => {
      await post(scope("/api/answers"), { id, result });
    },
    delivery,
    scope,
    thread,
    voice,
    draft,
    attachments,
    resources,
    realtime,
    connect: () => {
      const stopRecovery = attachments.store.subscribe(recoverDraft);
      const stopVoiceOnDisconnect = thread.subscribe(({ connected, state }) => {
        if ((!connected || state.connection !== "connected") && voice.getState().state !== "idle") {
          void realtime.stop();
        }
      });

      if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
        void navigator.serviceWorker.register("/sw.js").catch(console.error);
      }

      const stopNotifications = notifications.connect();
      const stopDraft = draft.connect();
      const stopThread = connectThread(thread, scope("/api/events"));

      return () => {
        stopRecovery();
        stopVoiceOnDisconnect();
        stopNotifications();
        stopDraft();
        stopThread();
        void realtime.stop();
      };
    },
  };
}

export type PocketClient = ReturnType<typeof createPocketClient>;
