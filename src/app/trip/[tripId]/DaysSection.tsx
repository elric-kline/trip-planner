import { formatCalendarDate } from "@/lib/time.ts";
import type { TripDay, TripDayWaypoint } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";
import DayItemBuilder from "./DayItemBuilder.tsx";
import { addWaypointAction, moveWaypointAction, removeWaypointAction, updateDayLocationsAction } from "./actions.ts";

/**
 * Day-by-day trip structure: where a multi-city trip wakes up and beds
 * down each day, whatever towns it passes through in between ("tour
 * destinations"), and now the day's own draft itinerary -- items land here
 * by day, not in a separate cross-day "Proposed" list (see page.tsx). See
 * schema.ts's tripDays comment for why wake/sleep are their own geocoded
 * fields rather than derived from a lodging item's check-in/check-out.
 *
 * A plain Server Component, not a client one -- every location/waypoint
 * interaction here is its own small `<form action={...}>` (same pattern as
 * the RSVP/lock forms elsewhere on the trip page). DayItemBuilder is the
 * one client island, for its hover-to-insert and expand-to-add-form state;
 * `<details>` gives the whole card its collapse/expand behavior for free,
 * no JS required.
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

/** A short one-line preview shown collapsed, before anyone clicks the day open. */
function itemsSummary(items: Item[]): string {
  if (items.length === 0) return "No items yet";
  const shown = items.slice(0, 3).map((i) => i.title);
  const more = items.length - shown.length;
  return `${items.length} item${items.length === 1 ? "" : "s"}: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

function DayCard({
  tripId,
  day,
  waypoints,
  items,
  timezone,
  destination,
  members,
}: {
  tripId: string;
  day: TripDay;
  waypoints: TripDayWaypoint[];
  items: Item[];
  timezone: string;
  destination: string;
  members: TripMemberSummary[];
}) {
  return (
    <details className="group rounded-md border border-stone-200 bg-white p-4">
      <summary className="cursor-pointer select-none">
        <span className="inline-flex w-[92%] items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-stone-700">{formatCalendarDate(day.date)}</h3>
          <span className="text-right text-xs text-stone-400">{itemsSummary(items)}</span>
        </span>
        {(day.wakeLocationName || day.sleepLocationName) && (
          <p className="mt-0.5 ml-[1.1em] text-xs text-stone-400">
            {day.wakeLocationName && `Wakes in ${day.wakeLocationName}`}
            {day.wakeLocationName && day.sleepLocationName && " · "}
            {day.sleepLocationName && `Sleeps in ${day.sleepLocationName}`}
          </p>
        )}
      </summary>

      <div className="mt-4 space-y-4 border-t border-stone-100 pt-4">
        {/* Keyed on the item count so a successful add remounts the builder
            fresh, collapsing whichever inline form was open back to its
            "+ Add" button -- its open/closed state is plain client state
            that (correctly) survives the server action's re-render on its
            own, so nothing else would tell it the add actually landed. */}
        <DayItemBuilder
          key={items.length}
          tripId={tripId}
          dayId={day.id}
          items={items}
          timezone={timezone}
          destination={destination}
          members={members}
        />

        <div>
          <p className="mb-2 text-xs font-medium text-stone-500">Wake / sleep locations</p>
          <form
            action={updateDayLocationsAction.bind(null, tripId, day.id)}
            className="grid grid-cols-2 gap-3"
          >
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Wake up in</span>
              <AddressAutocomplete
                name="wakeLocationName"
                defaultValue={day.wakeLocationName}
                placeholder="e.g. Seattle, WA"
                className="input"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">Sleep in</span>
              <AddressAutocomplete
                name="sleepLocationName"
                defaultValue={day.sleepLocationName}
                placeholder="e.g. Victoria, BC"
                className="input"
              />
            </label>
            <button type="submit" className="btn-secondary col-span-2 justify-self-start">
              Save
            </button>
          </form>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-stone-500">Tour destinations</p>
          {waypoints.length > 0 && (
            <ul className="mb-2 space-y-1">
              {waypoints.map((w, i) => (
                <li key={w.id} className="flex items-center justify-between gap-2 text-sm text-stone-700">
                  <span>
                    {i + 1}. {w.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1 text-xs">
                    <form action={moveWaypointAction.bind(null, tripId, w.id, "up")}>
                      <button
                        type="submit"
                        aria-label="Move earlier"
                        className="px-1 text-stone-400 hover:text-stone-700"
                      >
                        ↑
                      </button>
                    </form>
                    <form action={moveWaypointAction.bind(null, tripId, w.id, "down")}>
                      <button
                        type="submit"
                        aria-label="Move later"
                        className="px-1 text-stone-400 hover:text-stone-700"
                      >
                        ↓
                      </button>
                    </form>
                    <form action={removeWaypointAction.bind(null, tripId, w.id)}>
                      <button type="submit" className="px-1 text-red-500 underline">
                        Remove
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form action={addWaypointAction.bind(null, tripId, day.id)} className="flex gap-2">
            <AddressAutocomplete
              name="name"
              placeholder="Add a stop (e.g. lunch in Ennis)"
              className="input"
            />
            <button type="submit" className="btn-secondary shrink-0">
              Add stop
            </button>
          </form>
        </div>
      </div>
    </details>
  );
}
