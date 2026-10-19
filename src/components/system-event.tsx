import { InfoIcon } from "lucide-react";

export function SystemEvent() {
  return (
    <div className="system-event" data-system-event="pocket-restarted" role="note">
      <InfoIcon className="system-event-icon" aria-hidden="true" />
      <span>Pocket restarted</span>
    </div>
  );
}
