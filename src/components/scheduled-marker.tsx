import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { ClockIcon } from "lucide-react";

export function ScheduledMarker({ title }: { title: string }) {
  return (
    <Marker className="justify-center py-2" aria-label={`Scheduled task: ${title}`}>
      <MarkerIcon>
        <ClockIcon />
      </MarkerIcon>
      <MarkerContent>Scheduled task · {title}</MarkerContent>
    </Marker>
  );
}
