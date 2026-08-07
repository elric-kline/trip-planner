import type { TripDay, TripDayWaypoint } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import DayCard from "./DayCard.tsx";

/**
 * Day-by-day trip structure: where a multi-city trip wakes up and beds
 * down each day, whatever towns it passes through in between ("tour
 * destinations"), and the day's own draft itinerary -- items land here by
 * day, not in a separate cross-day "Proposed" list (see page.tsx). See
 * schema.ts's tripDays comment for why wake/sleep are their own geocoded
 * fields rather than derived from a lodging item's check-in/check-out.
 *
 * Just a thin map over DayCard, which owns all the actual open/closed
 * interaction (see its own comment for why that needs to be a client
 * component rather than native `<details>`).
 */
export default function DaysSection({
  tripId,
  days,
  waypointsByDay,
  itemsByDay,
  timezone,
  destination,
  members,
}: {
  tripId: string;
  days: TripDay[];
  waypointsByDay: Map<string, TripDayWaypoint[]>;
  itemsByDay: Map<string, Item[]>;
  timezone: string;
  destination: string;
  members: TripMemberSummary[];
}) {
  return (
    <div className="space-y-3">
      {days.map((day) => (
        <DayCard
          key={day.id}
          tripId={tripId}
          day={day}
          waypoints={waypointsByDay.get(day.id) ?? []}
          items={itemsByDay.get(day.id) ?? []}
          timezone={timezone}
          destination={destination}
          members={members}
        />
      ))}
    </div>
  );
}
