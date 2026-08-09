import type { TripDay } from "@/lib/days.ts";
import type { Item } from "@/lib/scope.ts";
import PlaySpaceDayCard from "./PlaySpaceDayCard.tsx";

/**
 * The **PlaySpace** tab's day-by-day view: the same day-by-day breakdown
 * Agreed uses, but for proposals instead of the settled record -- see
 * PlaySpaceDayCard for why it's a leaner card (no wake/sleep/stops editor).
 * Days with nothing proposed yet still render (an empty PlaySpaceDayCard),
 * same as Agreed, so a day with no proposals is visibly a gap rather than
 * silently missing.
 */
export default function PlaySpaceDaysSection({
  tripId,
  days,
  itemsByDay,
  timezone,
  supportCounts,
}: {
  tripId: string;
  days: TripDay[];
  itemsByDay: Map<string, Item[]>;
  timezone: string;
  supportCounts?: Map<string, number>;
}) {
  return (
    <div className="space-y-3">
      {days.map((day) => (
        <PlaySpaceDayCard
          key={day.id}
          tripId={tripId}
          day={day}
          items={itemsByDay.get(day.id) ?? []}
          timezone={timezone}
          supportCounts={supportCounts}
        />
      ))}
    </div>
  );
}
