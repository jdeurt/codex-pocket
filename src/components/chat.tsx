"use client";
import "./focused-composer.css";
import { useRef, useState } from "react";
import { useNavigationSwipe } from "@/hooks/use-navigation-swipe";
import { usePathname } from "next/navigation";
import { AgentBrowser } from "./agent-browser";
import { AgentNavigationContext } from "@/lib/agent-navigation-context";
import { Conversation } from "./conversation";
import { PocketMenu } from "./pocket-menu";
import { ChatComposer } from "./chat-composer";
import { connectionStatus } from "@/lib/connection-status";
import { modelDescription } from "@/lib/model-description";
import { useThread } from "@/hooks/use-thread";
import { usePocketSettings } from "@/hooks/use-pocket-settings";
import { usePocketClient } from "@/providers/pocket-state";
import { useRealtime } from "@/hooks/use-realtime";
import { useAppUpdate } from "@/hooks/use-app-update";
import { useBoundCallback } from "@/hooks/use-bound-callback";
import { openChatAgent, canReloadChat } from "@/runtime/chat-composer";

/** Compose scoped conversation rendering and component-local navigation panels.
@returns Parent chat with its existing menu, agent navigation and composer.
*/
export function Chat() {
  const { state, connected: streamConnected } = useThread();
  const settings = usePocketSettings();
  const isViewingFile = usePathname() === "/files";
  const client = usePocketClient();
  const voice = useRealtime(state.connection === "connected" ? state.threadId : undefined);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [pocketsOpen, setPocketsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const agentReturnFocus = useRef<HTMLElement | null>(null);
  const openAgent = useBoundCallback(openChatAgent, agentReturnFocus, setSelectedAgent, setAgentsOpen);
  const canReload = useBoundCallback(canReloadChat, client, pocketsOpen);

  const showAgents = useBoundCallback(setAgentsOpen, true);
  const showPockets = useBoundCallback(setPocketsOpen, true);
  const swipe = useNavigationSwipe<HTMLElement>(!agentsOpen && !pocketsOpen && !isViewingFile, showAgents, showPockets);

  useAppUpdate(canReload);

  const agentControl = (
    <AgentBrowser
      open={agentsOpen}
      selectedId={selectedAgent}
      onSelect={setSelectedAgent}
      returnFocusRef={agentReturnFocus}
      onOpenChange={setAgentsOpen}
    />
  );

  return (
    <AgentNavigationContext value={openAgent}>
      <main ref={swipe} className="chat-shell">
        <PocketMenu
          open={pocketsOpen}
          model={modelDescription(state)}
          status={connectionStatus(state, streamConnected)}
          onOpenChange={setPocketsOpen}
        />
        <Conversation
          state={state}
          realtimeSegments={voice.segments}
          suspended={agentsOpen || pocketsOpen || isViewingFile}
          activityControl={agentControl}
          showTools={settings.data?.showToolCalls ?? false}
        />
        <ChatComposer state={state} voice={voice} isConnected={streamConnected && state.connection === "connected"} />
      </main>
    </AgentNavigationContext>
  );
}
