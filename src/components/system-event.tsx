import { InfoIcon } from "lucide-react";

/**
Display the persisted restart notice as a read-only system note.
@returns The existing restart notice with note semantics.
*/
export function SystemEvent() {
  return (
    <div className="system-event" data-system-event="pocket-restarted" role="note">
      <InfoIcon className="system-event-icon" aria-hidden="true" />
      <span>Pocket restarted</span>
    </div>
  );
}
