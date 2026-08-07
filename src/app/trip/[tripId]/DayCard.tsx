"use client";

import { useState } from "react";
import { formatCalendarDate } from "@/lib/time.ts";
import type { DayLocationKind, TripDay, TripDayLocation } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";
import DayItemBuilder from "./DayItemBuilder.tsx";
import { addLocationAction, moveLocationAction, removeLocationAction, setLocationMembersAction } from "./actions.ts";

/** A short one-line preview of what's in the day, shown whether or not it's open. */
function itemsSummary(items: Item[]): string {
  if (items.length === 0) return "No items yet";
  const shown = items.slice(0, 3).map((i) => i.title);
  const more = items.length - shown.length;
  return `${items.length} item${items.length === 1 ? "" : "s"}: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/**
 * The row of member toggles on the "add a location" form -- name="includes",
 * one checkbox per trip member, all checked by default ("default all-in,
 * selectable" -- see schema.ts's tripDayLocationMembers).
 */
function IncludesCheckboxes({ members }: { members: TripMemberSummary[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {members.map((m) => (
        <label key={m.userId} className="flex items-center gap-1 text-xs text-stone-600">
          <input type="checkbox" name="includes" value={m.userId} defaultChecked />
          {m.name ?? m.email}
        </label>
      ))}
    </div>
  );
}

/**
 * One existing location's row in the editor: name, reorder/remove among
 * its own kind, and its own "Includes" checkboxes (reflecting who's
 * actually in it right now, not the all-checked default the add-form
 * uses -- this location already exists, so its real membership is known).
 */
function LocationRow({
  tripId,
  location,
  index,
  members,
  includedIds,
}: {
  tripId: string;
  location: TripDayLocation;
  index: number;
  members: TripMemberSummary[];
  includedIds: string[];
}) {
  return (
    <li className="rounded border border-stone-200 bg-white p-2">
      <div className="flex items-center justify-between gap-2 text-sm text-stone-700">
        <span>
          {index + 1}. {location.name}
        </span>
        <div className="flex shrink-0 items-center gap-1 text-xs">
          <form action={moveLocationAction.bind(null, tripId, location.id, "up")}>
            <button type="submit" aria-label="Move earlier" className="px-1 text-stone-400 hover:text-stone-700">
              ↑
            </button>
          </form>
          <form action={moveLocationAction.bind(null, tripId, location.id, "down")}>
            <button type="submit" aria-label="Move later" className="px-1 text-stone-400 hover:text-stone-700">
              ↓
            </button>
          </form>
          <form action={removeLocationAction.bind(null, tripId, location.id)}>
            <button type="submit" className="px-1 text-red-500 underline">
              Remove
            </button>
          </form>
        </div>
      </div>
      <form
        action={setLocationMembersAction.bind(null, tripId, location.id)}
        className="mt-2 flex flex-wrap items-center gap-2"
      >
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {members.map((m) => (
            <label key={m.userId} className="flex items-center gap-1 text-xs text-stone-600">
              <input type="checkbox" name="includes" value={m.userId} defaultChecked={includedIds.includes(m.userId)} />
              {m.name ?? m.email}
            </label>
          ))}
        </div>
        <button type="submit" className="text-xs text-stone-500 underline hover:text-stone-700">
          Save includes
        </button>
      </form>
    </li>
  );
}

/**
 * A day's wake, sleep, or stop locations, all rendered the same way -- a
 * list of existing ones (each with its own Includes editor) plus an
 * "add another" form. Wake and sleep are lists too, not a single slot:
 * a split departure (my brother and mother leave from Bethlehem, PA; I
 * leave from NYC) is two different wake locations on the same day, each
 * with a different Includes subset -- see days.ts's addLocation.
 */
function LocationKindSection({
  tripId,
  dayId,
  kind,
  label,
  placeholder,
  locations,
  locationMembers,
  members,
}: {
  tripId: string;
  dayId: string;
  kind: DayLocationKind;
  label: string;
  placeholder: string;
  locations: TripDayLocation[];
  locationMembers: Map<string, string[]>;
  members: TripMemberSummary[];
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-stone-500">{label}</p>
      {locations.length > 0 && (
        <ul className="mb-3 space-y-2">
          {locations.map((location, i) => (
            <LocationRow
              key={location.id}
              tripId={tripId}
              location={location}
              index={i}
              members={members}
              includedIds={locationMembers.get(location.id) ?? []}
            />
          ))}
        </ul>
      )}
      <form action={addLocationAction.bind(null, tripId, dayId, kind)} className="space-y-2">
        <AddressAutocomplete name="name" placeholder={placeholder} className="input" restrict="place" />
        <IncludesCheckboxes members={members} />
        <button type="submit" className="btn-secondary">
          Add
        </button>
      </form>
    </div>
  );
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
 *
 * The always-visible summary line is filtered to locations that include
 * the *viewer* -- "my personal view shows me where I'm going to be," not
 * everyone else's leg of a split day (see schema.ts's tripDayLocationMembers
 * for the Bethlehem/NYC example). The pencil's editor panel shows every
 * location regardless of who's in it, since managing the whole party's
 * plan is still any trip member's job.
 */
export default function DayCard({
  tripId,
  day,
  locations,
  locationMembers,
  items,
  timezone,
  destination,
  members,
  viewerId,
}: {
  tripId: string;
  day: TripDay;
  locations: TripDayLocation[];
  locationMembers: Map<string, string[]>;
  items: Item[];
  timezone: string;
  destination: string;
  members: TripMemberSummary[];
  viewerId: string;
}) {
  const [itemsOpen, setItemsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const wakes = locations.filter((l) => l.kind === "wake");
  const sleeps = locations.filter((l) => l.kind === "sleep");
  const stops = locations.filter((l) => l.kind === "stop"); // already position-sorted (see locationsForDays)

  const includesViewer = (locationId: string) => (locationMembers.get(locationId) ?? []).includes(viewerId);
  const myWakes = wakes.filter((l) => includesViewer(l.id));
  const mySleeps = sleeps.filter((l) => includesViewer(l.id));
  const myStops = stops.filter((l) => includesViewer(l.id));

  const wakeSleepLine = [...myWakes.map((l) => `Wakes in ${l.name}`), ...mySleeps.map((l) => `Sleeps in ${l.name}`)].join(
    " — ",
  );
  const hasAnythingForMe = Boolean(myWakes.length || mySleeps.length || myStops.length);
  const hasAnythingAtAll = locations.length > 0;

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
        <div className="text-xs text-stone-400">
          {!hasAnythingForMe ? (
            <p>{hasAnythingAtAll ? "Set for other travelers, not you" : "No wake/sleep or stops set yet"}</p>
          ) : (
            <>
              {wakeSleepLine && <p>{wakeSleepLine}</p>}
              {myStops.length > 0 && (
                <ul>
                  {myStops.map((s) => (
                    <li key={s.id}>{s.name}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
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
          <LocationKindSection
            tripId={tripId}
            dayId={day.id}
            kind="wake"
            label="Wake locations"
            placeholder="e.g. Bethlehem, PA"
            locations={wakes}
            locationMembers={locationMembers}
            members={members}
          />
          <LocationKindSection
            tripId={tripId}
            dayId={day.id}
            kind="sleep"
            label="Sleep locations"
            placeholder="e.g. Galway, Ireland"
            locations={sleeps}
            locationMembers={locationMembers}
            members={members}
          />
          <LocationKindSection
            tripId={tripId}
            dayId={day.id}
            kind="stop"
            label="Stops"
            placeholder="Add a stop (e.g. lunch in Ennis)"
            locations={stops}
            locationMembers={locationMembers}
            members={members}
          />
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
