import type { TripDay, TripDayLocation } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import DayCard from "./DayCard.tsx";

/**
 * The **Agreed** tab's day-by-day view: the settled record of where a
 * multi-city trip wakes up and beds down each day, whatever towns it
 * passes through in between ("tour destinations"), and whatever's actually
 * locked in for that day. See schema.ts's tripDayLocations comment for why
 * wake/sleep/stops are all one table rather than tripDays columns plus a
 * separate waypoints table, and page.tsx for why `itemsByDay` here only
 * ever holds locked items -- Agreed is a record, not a workspace; that's
 * PlaySpace's job (see PlaySpaceDaysSection.tsx).
 *
 * Just a thin map over DayCard, which owns all the actual open/closed
 * interaction (see its own comment for why that needs to be a client
 * component rather than native `<details>`).
 */
export default function AgreedDaysSection({
  tripId,
  days,
  locationsByDay,
  locationMembers,
  itemsByDay,
  timezone,
  members,
  viewerId,
  conflictedItemIds,
}: {
  tripId: string;
  days: TripDay[];
  locationsByDay: Map<string, TripDayLocation[]>;
  locationMembers: Map<string, string[]>;
  itemsByDay: Map<string, Item[]>;
  timezone: string;
  members: TripMemberSummary[];
  viewerId: string;
  conflictedItemIds?: Set<string>;
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
          members={members}
          viewerId={viewerId}
          conflictedItemIds={conflictedItemIds}
        />
      ))}
    </div>
  );
}
