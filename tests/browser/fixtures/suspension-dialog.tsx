"use client";

import "../../../src/components/focused-composer.css";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Prompt } from "../../../src/components/prompt";
import type { Snapshot } from "../../../src/lib/protocol";
import { VirtualizedTranscript } from "../../../src/components/virtualized-transcript";
import { suspensionHistory } from "./suspension-data";
import { turnMessages } from "../../../src/lib/turn-messages";
import { useComposerViewport } from "../../../src/hooks/use-composer-viewport";

const BANNER_HEIGHT = 134;
const ActivityContext = createContext(false);

function ActivitySlot() {
  const active = useContext(ActivityContext);

  return active ? (
    <div className="activity-row">
      <span role="status">Parent working</span>
      <Dialog.Trigger id="fixture-agents">Open child overlay</Dialog.Trigger>
    </div>
  ) : null;
}

export function SuspensionDialogFixture() {
  const [state, setState] = useState<Snapshot>(() => ({ ...suspensionHistory(), activeTurnId: "parent" }));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const shell = useRef<HTMLElement>(null);
  useComposerViewport(composer);
  useEffect(() => {
    const update = (event: Event) => setState((event as CustomEvent<Snapshot>).detail);
    globalThis.addEventListener("suspension-snapshot", update);

    if (shell.current) {
      shell.current.dataset.fixtureReady = "true";
    }

    return () => globalThis.removeEventListener("suspension-snapshot", update);
  }, []);
  const turns = state.turns.map((turn) => ({ id: turn.id, entries: turnMessages(turn, false) }));

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <main ref={shell} className="chat-shell" data-revision={state.activity}>
        <header>Parent dialog fixture</header>
        <VirtualizedTranscript turns={turns} suspended={open}>
          {state.requests.map((request) => (
            <Prompt
              key={request.id}
              request={request}
              answer={() => Promise.reject(new Error("Fixture is read-only"))}
            />
          ))}
          <ActivityContext.Provider value={!!state.activeTurnId}>
            <ActivitySlot />
          </ActivityContext.Provider>
        </VirtualizedTranscript>
        <footer className="composer-wrap">
          {state.error && (
            <div role="alert" style={{ height: BANNER_HEIGHT }}>
              {state.error}
            </div>
          )}
          <div className="composer">
            <textarea
              ref={composer}
              id="fixture-composer"
              aria-label="Parent draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        </footer>
      </main>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-background/50" />
        <Dialog.Popup
          className="fixed inset-0 z-50 bg-background transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0"
          finalFocus={() => document.querySelector<HTMLButtonElement>("#fixture-agents") ?? composer.current}
        >
          <Dialog.Title>Child overlay</Dialog.Title>
          <Dialog.Description>Synthetic child; the parent remains mounted.</Dialog.Description>
          <Dialog.Close>Return to parent</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
