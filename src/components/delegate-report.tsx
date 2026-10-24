"use client";
import "./delegate-report.css";
import { Bubble, BubbleContent } from "./ui/bubble";
import { ArrowRightIcon, ChevronDownIcon, MessageCircleIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Message, MessageContent } from "./ui/message";
import { useContext, useState } from "react";
import { AgentNavigationContext } from "@/lib/agent-navigation-context";
import { Button } from "./ui/button";
import { type DelegateReport as Report } from "@/lib/delegate-reports";
import { openAgentFromButton } from "../runtime/form-events";
import { collapseDetail } from "../runtime/disclosure-click";

/**
Preview one line of the original report, with an optional full report and read-only agent history.
@param props - Durable display projection retaining its sending agent's read-only navigation identity.
@returns A collapsed disclosure preserving the complete original report and agent navigation.
*/
export function DelegateReport({ report }: { report: Report }) {
  const openAgent = useContext(AgentNavigationContext);
  const [isOpen, setIsOpen] = useState(false);

  if (!report.final) {
    return (
      <Message>
        <MessageContent>
          <Bubble variant="ghost">
            <BubbleContent>
              <div className="whitespace-pre-wrap" data-interim-report-id={report.id}>
                {report.text.trimEnd()}
              </div>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message>
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full">
            <Collapsible open={isOpen} onOpenChange={setIsOpen}>
              <CollapsibleTrigger
                className="delegate-report"
                data-report-id={report.id}
                data-report-status={report.status}
                aria-label={isOpen ? "Collapse agent report" : "Expand agent report"}
              >
                <MessageCircleIcon aria-hidden="true" className="delegate-report-icon" />
                <span className="min-w-0 flex-1 truncate">{report.text.trim() || "Agent report"}</span>
                <ChevronDownIcon aria-hidden="true" className="delegate-report-chevron" />
              </CollapsibleTrigger>
              <CollapsibleContent onClick={collapseDetail.bind(undefined, setIsOpen.bind(undefined, false))}>
                <div className="delegate-report-details">
                  <div className="whitespace-pre-wrap">{report.text.trimEnd()}</div>
                  {openAgent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="delegate-report-open"
                      onClick={openAgentFromButton.bind(undefined, openAgent, report.agentId)}
                    >
                      <ArrowRightIcon aria-hidden="true" />
                      Open Side Pocket
                    </Button>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
