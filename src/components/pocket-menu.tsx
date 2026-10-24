"use client";
import "./pocket-menu.css";
import { ArrowLeftIcon, MenuIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon, XIcon } from "lucide-react";
import { POCKET_NAME_LIMIT, type Pocket, pocketHref, pocketsSchema } from "@/lib/pockets";
import { usePocketId } from "../providers/pocket-navigation-context";
import { useEffect, useRef, useReducer } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { PocketSettingsPanel } from "./pocket-settings";
import { usePocketClient } from "@/providers/pocket-state";
import { useStore } from "zustand";
import { type PocketEdit as Edit } from "@/services/pockets";
import { useBoundCallback } from "@/hooks/use-bound-callback";
import { findById } from "@/lib/identity";
import { isOperationBusy } from "@/state/resource";
import { initialPocketMenu, pocketMenuChanged } from "@/state/pocket-menu";
import {
  createPocketEdit,
  renamePocketEdit,
  selectPocketEdit,
  cancelPocketEdit,
  savePocketEdit,
  openPocketMenu,
} from "@/runtime/pocket-menu";
import { focusControl, submitOperation, updateInput } from "@/runtime/form-events";
import { useAgentRead } from "@/hooks/use-agents";

/** Show a saved name, current work preview, and explicit management controls.
@param props - Durable entry, current selection, and editor callback.
@returns A selectable Pocket with independent rename/delete buttons.
*/
function PocketEntry({ pocket, selected, edit }: { pocket: Pocket; selected: boolean; edit: (value: Edit) => void }) {
  return (
    <li className="pocket-entry" data-selected={selected || undefined}>
      {pocket.state === "ready" ? (
        <a href={pocketHref(pocket.id)} aria-current={selected ? "page" : undefined} className="pocket-link">
          <span className="pocket-name">{pocket.name}</span>
          <span className="pocket-status">
            {pocket.status}
            {selected ? " · Current" : ""}
          </span>
          <span className="pocket-preview">{pocket.preview || "No messages yet"}</span>
        </a>
      ) : (
        <div className="pocket-link">
          <span className="pocket-name">{pocket.name}</span>
          <span className="pocket-status">{pocket.state === "creating" ? "Creating…" : "Setup incomplete"}</span>
        </div>
      )}
      <div className="pocket-actions">
        <button
          type="button"
          aria-label={`Rename ${pocket.name}`}
          onClick={edit.bind(undefined, { action: "rename", id: pocket.id, name: pocket.name })}
        >
          <PencilIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Delete ${pocket.name}`}
          onClick={edit.bind(undefined, { action: "delete", id: pocket.id, name: pocket.name })}
        >
          <Trash2Icon aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/** Render an explicitly selected catalog entry.
@param selected - Current Pocket identity.
@param edit - Local editor action.
@param entry - Catalog entry.
@returns Stable Pocket row.
*/
function pocketEntry(selected: string, edit: (value: Edit) => void, entry: Pocket) {
  return <PocketEntry key={entry.id} pocket={entry} selected={entry.id === selected} edit={edit} />;
}

/** Keep editing and deletion confirmation local to the menu with recoverable errors.
@param props - Current edit, submission state, and callbacks preserving the entered name.
@returns The named-Pocket editor or explicit deletion confirmation.
*/
function PocketEditor({
  edit,
  busy,
  change,
  cancel,
  submit,
}: {
  edit: Edit;
  busy: boolean;
  change: (name: string) => void;
  cancel: () => void;
  submit: () => Promise<void>;
}) {
  const labels = { create: "Create Pocket", rename: "Save name", delete: "Delete Pocket" };
  const input = useRef<HTMLInputElement>(null);

  const focus = useBoundCallback(focusControl, input);

  useEffect(focus, [focus, edit.id]);

  return (
    <form className="pocket-editor" onSubmit={submitOperation.bind(undefined, submit)}>
      {edit.action === "delete" ? (
        <p>Delete “{edit.name}” from Pocket? Its saved Codex history stays on your computer.</p>
      ) : (
        <label htmlFor="pocket-name">
          Pocket name
          <input
            ref={input}
            id="pocket-name"
            value={edit.name}
            maxLength={POCKET_NAME_LIMIT}
            required
            disabled={busy}
            onChange={updateInput.bind(undefined, change)}
          />
        </label>
      )}
      <div className="pocket-editor-actions">
        <button type="button" disabled={busy} onClick={cancel}>
          {edit.action === "delete" ? "Keep Pocket" : "Cancel"}
        </button>
        <button type="submit" disabled={busy || !edit.name.trim()}>
          {busy ? "Saving…" : labels[edit.action]}
        </button>
      </div>
    </form>
  );
}

/** Identify the current menu section and keep its navigation in the same modal.
@param props - Current section, submission lock, and return callback.
@returns Accessible title, description, back action, and close action.
*/
function MenuHeading({ isSettings, busy, back }: { isSettings: boolean; busy: boolean; back: () => void }) {
  return (
    <>
      <div className="pockets-heading">
        {isSettings && (
          <button type="button" aria-label="Back to Pockets" disabled={busy} onClick={back}>
            <ArrowLeftIcon aria-hidden="true" />
          </button>
        )}
        <Dialog.Title>{isSettings ? "Settings" : "Pockets"}</Dialog.Title>
        <Dialog.Close aria-label={isSettings ? "Close Settings" : "Close Pockets"} disabled={busy}>
          <XIcon aria-hidden="true" />
        </Dialog.Close>
      </div>
      <Dialog.Description className="sr-only">
        {isSettings
          ? "Manage Pocket preferences and the OpenAI API key on this computer."
          : "Create named conversations and switch between their current work."}
      </Dialog.Description>
    </>
  );
}

/** Place named-Pocket navigation at the top left while centering the current chat title.
@param props - Current model description and connection label from the selected parent.
@returns Header and accessible menu retaining the selected parent's independent URL.
*/
export function PocketMenu({
  model,
  status,
  onOpenChange,
}: {
  model: string;
  status: string;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const [{ isOpen: open, isSettingsOpen: settingsOpen, edit }, dispatch] = useReducer(
    pocketMenuChanged,
    initialPocketMenu
  );
  const { pockets, settings } = usePocketClient();
  const operation = useStore(pockets.store);
  const isSavingSettings = useStore(settings.store, isOperationBusy);
  const isBusy = operation.busy || isSavingSettings;
  const error = operation.error;
  const { data, error: readError } = useAgentRead("/api/pockets", pocketsSchema);
  const selected = usePocketId();
  const current = findById(data?.pockets ?? [], selected);

  return (
    <header className="chat-header pocket-header">
      <Dialog.Root open={open} onOpenChange={openPocketMenu.bind(undefined, pockets, dispatch, onOpenChange, isBusy)}>
        <Dialog.Trigger className="pocket-menu-trigger" aria-label="Open Pockets">
          <MenuIcon aria-hidden="true" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="agents-backdrop" />
          <Dialog.Popup className="pockets-panel">
            <MenuHeading
              isSettings={settingsOpen}
              busy={isBusy}
              back={dispatch.bind(undefined, { type: "settings", isOpen: false })}
            />
            <div className="pockets-content">
              {(error || readError) && <p role="alert">{error || readError}</p>}
              {!data && !readError && !settingsOpen && <p role="status">Loading Pockets…</p>}
              {settingsOpen && <PocketSettingsPanel />}
              {edit && (
                <PocketEditor
                  edit={edit}
                  busy={isBusy}
                  change={renamePocketEdit.bind(undefined, dispatch)}
                  cancel={cancelPocketEdit.bind(undefined, pockets, dispatch)}
                  submit={savePocketEdit.bind(undefined, pockets, dispatch, edit, isBusy)}
                />
              )}
              {!edit && !settingsOpen && (
                <>
                  <button
                    className="pocket-create"
                    type="button"
                    onClick={dispatch.bind(undefined, { type: "settings", isOpen: true })}
                  >
                    <SettingsIcon aria-hidden="true" />
                    Settings
                  </button>
                  <button className="pocket-create" type="button" onClick={createPocketEdit.bind(undefined, dispatch)}>
                    <PlusIcon aria-hidden="true" />
                    New Pocket
                  </button>
                  <ul aria-label="Your Pockets">
                    {Array.from(
                      data?.pockets ?? [],
                      pocketEntry.bind(undefined, selected, selectPocketEdit.bind(undefined, dispatch))
                    )}
                  </ul>
                </>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="thread-heading">
        <h1>{current?.name ?? "Pocket"}</h1>
        <p>
          <span aria-label="Model and reasoning effort">{model}</span>
          <span aria-hidden="true"> · </span>
          <span role="status">{status}</span>
        </p>
      </div>
      <span className="pocket-header-balance" aria-hidden="true" />
    </header>
  );
}
