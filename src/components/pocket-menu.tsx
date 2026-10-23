"use client";
import "./pocket-menu.css";
import { ArrowLeftIcon, MenuIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon, XIcon } from "lucide-react";
import { POCKET_NAME_LIMIT, type Pocket, pocketHref, pocketsSchema, selectedPocketId } from "@/lib/pockets";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { PocketSettingsPanel } from "./pocket-settings";
import { post } from "@/lib/client-api";
import { useAgentRead } from "@/hooks/use-agents";

interface Edit {
  action: "create" | "rename" | "delete";
  id: string;
  name: string;
}

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
          onClick={() => {
            edit({ action: "rename", id: pocket.id, name: pocket.name });
          }}
        >
          <PencilIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Delete ${pocket.name}`}
          onClick={() => {
            edit({ action: "delete", id: pocket.id, name: pocket.name });
          }}
        >
          <Trash2Icon aria-hidden="true" />
        </button>
      </div>
    </li>
  );
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

  useEffect(() => {
    input.current?.focus();
  }, [edit.id]);

  return (
    <form
      className="pocket-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
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
            onChange={(event) => {
              change(event.target.value);
            }}
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
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data, error: readError } = useAgentRead("/api/pockets", pocketsSchema);
  const selected = selectedPocketId();
  const current = data?.pockets.find((entry) => entry.id === selected);

  async function saveEdit(change: Edit) {
    const result = await post(
      "/api/pockets",
      change.action === "delete" ? { action: change.action, id: change.id } : change
    );
    const entries = pocketsSchema.shape.pockets.parse(result.pockets);
    const created = entries.find((entry) => entry.id === change.id);

    if (change.action === "create" && created?.state !== "ready") {
      throw new Error("Setup did not finish. Delete this entry before trying a new Pocket.");
    }

    if (change.action === "create" || (change.action === "delete" && change.id === selected)) {
      location.assign(
        pocketHref(
          change.action === "create" ? change.id : (entries.find((entry) => entry.state === "ready")?.id ?? "main")
        )
      );

      return;
    }

    setEdit(null);
    globalThis.dispatchEvent(new Event("online"));
  }

  async function submit() {
    if (!edit || busy) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await saveEdit(edit);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Could not save this Pocket.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="chat-header pocket-header">
      <Dialog.Root
        open={open}
        onOpenChange={(value, details) => {
          if (busy) {
            details.cancel();

            return;
          }

          setOpen(value);
          onOpenChange(value);
          setError("");
          setEdit(null);
          setSettingsOpen(false);
        }}
      >
        <Dialog.Trigger className="pocket-menu-trigger" aria-label="Open Pockets">
          <MenuIcon aria-hidden="true" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="agents-backdrop" />
          <Dialog.Popup className="pockets-panel">
            <MenuHeading
              isSettings={settingsOpen}
              busy={busy}
              back={() => {
                setSettingsOpen(false);
              }}
            />
            <div className="pockets-content">
              {(error || readError) && <p role="alert">{error || readError}</p>}
              {!data && !readError && !settingsOpen && <p role="status">Loading Pockets…</p>}
              {settingsOpen && <PocketSettingsPanel busy={busy} onBusyChange={setBusy} />}
              {edit && (
                <PocketEditor
                  edit={edit}
                  busy={busy}
                  change={(name) => {
                    setEdit({ ...edit, name });
                  }}
                  cancel={() => {
                    setEdit(null);
                    setError("");
                  }}
                  submit={submit}
                />
              )}
              {!edit && !settingsOpen && (
                <>
                  <button
                    className="pocket-create"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(true);
                    }}
                  >
                    <SettingsIcon aria-hidden="true" />
                    Settings
                  </button>
                  <button
                    className="pocket-create"
                    type="button"
                    onClick={() => {
                      setEdit({ action: "create", id: crypto.randomUUID(), name: "" });
                    }}
                  >
                    <PlusIcon aria-hidden="true" />
                    New Pocket
                  </button>
                  <ul aria-label="Your Pockets">
                    {data?.pockets.map((entry) => (
                      <PocketEntry key={entry.id} pocket={entry} selected={entry.id === selected} edit={setEdit} />
                    ))}
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
