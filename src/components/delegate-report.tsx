"use client";
import "./delegate-report.css";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Message, MessageContent } from "./ui/message";
import { AgentNavigationContext } from "@/lib/agent-navigation-context";
import { type DelegateReport as Report } from "@/lib/delegate-reports";
import { MessageCircleIcon } from "lucide-react";
import { useContext } from "react";

/**
Display only the muted incoming-report icon and streamed paraphrase using the shared message text size.
@param props - Durable display projection retaining its sending agent's read-only navigation identity.
@returns A keyboard-accessible report that opens the existing agent browser without sending input.
*/
export function DelegateReport({ report }: { report: Report }) {
  const openAgent = useContext(AgentNavigationContext);

  return (
    <Message>
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <button
              type="button"
              className="delegate-report"
              data-report-id={report.id}
              data-report-status={report.status}
              aria-label={report.text || "Open incoming delegate report"}
              onClick={(event) => openAgent?.(report.agentId, event.currentTarget)}
            >
              <MessageCircleIcon aria-hidden="true" className="delegate-report-icon" />
              <span className="whitespace-pre-wrap">{report.text}</span>
            </button>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
