import type { TripDay, TripDayLocation } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import DayCard from "./DayCard.tsx";

/**
 * Day-by-day trip structure: where a multi-city trip wakes up and beds
 * down each day, whatever towns it passes through in between ("tour
 * destinations"), and the day's own draft itinerary -- items land here by
 * day, not in a separate cross-day "Proposed" list (see page.tsx). See
 * schema.ts's tripDayLocations comment for why wake/sleep/stops are all
 * one table rather than tripDays columns plus a separate waypoints table.
 *
 * Just a thin map over DayCard, which owns all the actual open/closed
 * interaction (see its own comment for why that needs to be a client
 * component rather than native `<details>`).
 */
export default function DaysSection({
  tripId,
  days,
  locationsByDay,
  locationMembers,
  itemsByDay,
  timezone,
  destination,
  members,
  viewerId,
}: {
  tripId: string;
  days: TripDay[];
  locationsByDay: Map<string, TripDayLocation[]>;
  locationMembers: Map<string, string[]>;
  itemsByDay: Map<string, Item[]>;
  timezone: string;
  destination: string;
  members: TripMemberSummary[];
  viewerId: string;
}) {
  return (
    <div className="space-y-3">
      {days.map((day) => (
        <DayCard
          key={day.id}
          tripId={tripId}
          day={day}
          locations={locationsByDay.get(day.id) ?? []}
          locationMembers={locationMembers}
          items={itemsByDay.get(day.id) ?? []}
          timezone={timezone}
          destination={destination}
          members={members}
          viewerId={viewerId}
        />
      ))}
    </div>
  );
}
