import { formatCalendarDate } from "@/lib/time.ts";
import type { TripDay, TripDayWaypoint } from "@/lib/days.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";
import { addWaypointAction, moveWaypointAction, removeWaypointAction, updateDayLocationsAction } from "./actions.ts";

/**
 * Day-by-day trip structure, independent of the itinerary's items: where a
 * multi-city trip wakes up and beds down each day, plus whatever towns it
 * passes through in between ("tour destinations"). See schema.ts's tripDays
 * comment for why wake/sleep are their own geocoded fields rather than
 * derived from a lodging item's check-in/check-out.
 *
 * A plain Server Component, not a client one -- every interaction here is
 * its own small `<form action={...}>` (same pattern as the RSVP/lock forms
 * elsewhere on the trip page), with AddressAutocomplete as the only client
 * island, for the typing-suggestions aid.
 */
export default function DaysSection({
  tripId,
  days,
  waypointsByDay,
}: {
  tripId: string;
  days: TripDay[];
  waypointsByDay: Map<string, TripDayWaypoint[]>;
}) {
  return (
    <div className="space-y-3">
      {days.map((day) => (
        <DayCard key={day.id} tripId={tripId} day={day} waypoints={waypointsByDay.get(day.id) ?? []} />
      ))}
    </div>
  );
}

function DayCard({
  tripId,
  day,
  waypoints,
}: {
  tripId: string;
  day: TripDay;
  waypoints: TripDayWaypoint[];
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <h3 className="mb-2 text-sm font-semibold text-stone-700">{formatCalendarDate(day.date)}</h3>

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

      {waypoints.length > 0 && (
        <ul className="mt-3 space-y-1">
          {waypoints.map((w, i) => (
            <li key={w.id} className="flex items-center justify-between gap-2 text-sm text-stone-700">
              <span>
                {i + 1}. {w.name}
              </span>
              <div className="flex shrink-0 items-center gap-1 text-xs">
                <form action={moveWaypointAction.bind(null, tripId, w.id, "up")}>
                  <button type="submit" aria-label="Move earlier" className="px-1 text-stone-400 hover:text-stone-700">
                    ↑
                  </button>
                </form>
                <form action={moveWaypointAction.bind(null, tripId, w.id, "down")}>
                  <button type="submit" aria-label="Move later" className="px-1 text-stone-400 hover:text-stone-700">
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

      <form action={addWaypointAction.bind(null, tripId, day.id)} className="mt-2 flex gap-2">
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
  );
}
