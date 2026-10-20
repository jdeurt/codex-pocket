"use client";

import { useEffect, useState } from "react";
import type { Snapshot } from "../../../src/lib/protocol";
import { VirtualizedTranscript } from "../../../src/components/virtualized-transcript";
import { suspensionHistory } from "./suspension-data";
import { turnMessages } from "../../../src/lib/turn-messages";

export function SuspensionFixture() {
  const [state, setState] = useState(suspensionHistory);
  const [open, setOpen] = useState(false);
  const [hide, setHide] = useState(false);
  const [draft, setDraft] = useState("");
  const [openedOffset, setOpenedOffset] = useState(0);
  useEffect(() => {
    const update = (event: Event) => setState((event as CustomEvent<Snapshot>).detail);
    globalThis.addEventListener("suspension-snapshot", update);

    return () => globalThis.removeEventListener("suspension-snapshot", update);
  }, []);
  const turns = state.turns.map((turn) => ({ id: turn.id, entries: turnMessages(turn, turn.status === "inProgress") }));

  return (
    <main className="chat-shell">
      <header>
        <button
          type="button"
          onClick={() => {
            setOpenedOffset(
              globalThis.document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')?.scrollTop ?? 0
            );
            setOpen(true);
          }}
        >
          Open child overlay
        </button>
        <label>
          <input type="checkbox" checked={hide} onChange={(event) => setHide(event.target.checked)} />
          Hide parent layout
        </label>
      </header>
      <div className="flex min-h-0 flex-1 flex-col" style={{ display: open && hide ? "none" : undefined }}>
        <VirtualizedTranscript turns={turns} suspended={open}>
          {state.queue.map((item) => (
            <div key={item.id} data-delivery={item.status} data-message-id={item.id}>
              {item.text}
            </div>
          ))}
          <div>
            <textarea aria-label="Pending answer draft" defaultValue="" />
          </div>
        </VirtualizedTranscript>
      </div>
      <footer>
        <textarea aria-label="Parent draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </footer>
      {open && (
        <div
          role="dialog"
          aria-label="Child overlay"
          data-parent-offset={openedOffset}
          className="fixed inset-0 z-50 bg-background"
        >
          <button id="fixture-return" type="button" onClick={() => setOpen(false)}>
            Return to parent
          </button>
        </div>
      )}
    </main>
  );
}
