"use client";

import { useState } from "react";
import { formatCalendarDate } from "@/lib/time.ts";
import type { TripDay, TripDayWaypoint } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";
import DayItemBuilder from "./DayItemBuilder.tsx";
import { addWaypointAction, moveWaypointAction, removeWaypointAction, updateDayLocationsAction } from "./actions.ts";

/** A short one-line preview of what's in the day, shown whether or not it's open. */
function itemsSummary(items: Item[]): string {
  if (items.length === 0) return "No items yet";
  const shown = items.slice(0, 3).map((i) => i.title);
  const more = items.length - shown.length;
  return `${items.length} item${items.length === 1 ? "" : "s"}: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/**
 * Wake/sleep/stops are the day's own *definition* -- where it starts, ends,
 * and passes through -- not something "in" the day the way an activity or
 * a dinner reservation is. Summarized in this line whether or not anything
 * is set yet, so the pencil always has somewhere to attach.
 */
function definitionSummary(day: TripDay, waypoints: TripDayWaypoint[]): string {
  const parts: string[] = [];
  if (day.wakeLocationName) parts.push(`Wakes in ${day.wakeLocationName}`);
  if (day.sleepLocationName) parts.push(`Sleeps in ${day.sleepLocationName}`);
  if (waypoints.length > 0) parts.push(`Stops: ${waypoints.map((w) => w.name).join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "No wake/sleep or stops set yet";
}

/**
 * A day's own header (date, item preview, and its wake/sleep/stops
 * definition) is always visible; the two things it can expand -- the item
 * workspace and the day-properties editor -- are independent toggles, not
 * nested `<details>`, because a pencil living inside a native `<summary>`
 * would also toggle the whole card open on every click. Plain client state
 * instead: clicking the header opens/closes the item builder (the "clean
 * working space" for activities/dining/lodging -- things the day *has*),
 * clicking the pencil opens/closes the wake/sleep/stops editor (properties
 * *of* the day itself).
 */
export default function DayCard({
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
  const [itemsOpen, setItemsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <button
        type="button"
        onClick={() => setItemsOpen((v) => !v)}
        aria-expanded={itemsOpen}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <h3 className="text-sm font-semibold text-stone-700">
          <span className="mr-1 inline-block w-3 text-stone-400">{itemsOpen ? "▾" : "▸"}</span>
          {formatCalendarDate(day.date)}
        </h3>
        <span className="text-right text-xs text-stone-400">{itemsSummary(items)}</span>
      </button>

      <div className="mt-0.5 flex items-start justify-between gap-2 pl-[1.35em]">
        <p className="text-xs text-stone-400">{definitionSummary(day, waypoints)}</p>
        <button
          type="button"
          onClick={() => setEditOpen((v) => !v)}
          aria-expanded={editOpen}
          aria-label="Edit wake/sleep and stops for this day"
          title="Edit wake/sleep and stops"
          className="shrink-0 leading-none text-stone-400 hover:text-stone-700"
        >
          ✏️
        </button>
      </div>

      {editOpen && (
        <div className="mt-3 space-y-4 rounded-md border border-stone-100 bg-stone-50 p-3">
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
      )}

      {itemsOpen && (
        <div className="mt-4 border-t border-stone-100 pt-4">
          {/* Keyed on the item count so a successful add remounts the
              builder fresh, collapsing whichever inline form was open back
              to its "+ Add" button -- see DayItemBuilder for why. */}
          <DayItemBuilder
            key={items.length}
            tripId={tripId}
            dayId={day.id}
            items={items}
            timezone={timezone}
            destination={destination}
            members={members}
          />
        </div>
      )}
    </div>
  );
}
