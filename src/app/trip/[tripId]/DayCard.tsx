"use client";

import { useState } from "react";
import { formatCalendarDate } from "@/lib/time.ts";
import type { DayLocationKind, TripDay, TripDayLocation } from "@/lib/days.ts";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";
import { ItemList } from "./itemDisplay.tsx";
import Sheet from "./Sheet.tsx";
import { addLocationAction, moveLocationAction, removeLocationAction, updateLocationAction } from "./actions.ts";

/** A one-line preview of the day, shown while it's collapsed. Agreed only ever receives locked items -- see page.tsx. */
function itemsSummary(items: Item[]): string {
  if (items.length === 0) return "Nothing locked yet";
  const shown = items.slice(0, 3).map((i) => i.title);
  const more = items.length - shown.length;
  return `${items.length} locked: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
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
 * One existing location's row in the editor. No numbering -- position in
 * the list already shows order, and wake/sleep locations aren't sequential
 * at all (they're parallel branches, not steps), so a "1., 2." prefix
 * never meant much beyond stops, and wasn't worth a special case.
 *
 * Reorder/remove are their own tiny one-button forms (plain HTML forbids
 * nesting a `<form>` inside another), but the name and Includes checkboxes
 * are deliberately ONE form with ONE "Save" -- editing a location's name
 * (e.g. splitting a combined "PA/NYC" entry down to just "PA" so "NYC" can
 * become its own location) and adjusting who's in it are both "this
 * location, as I want it now," not two separate edits.
 */
function LocationRow({
  tripId,
  location,
  members,
  includedIds,
}: {
  tripId: string;
  location: TripDayLocation;
  members: TripMemberSummary[];
  includedIds: string[];
}) {
  return (
    <li className="rounded border border-stone-200 bg-white p-2">
      <div className="flex items-center justify-end gap-1 text-xs">
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
      <form action={updateLocationAction.bind(null, tripId, location.id)} className="mt-1 space-y-2">
        <AddressAutocomplete name="name" defaultValue={location.name} className="input" restrict="place" />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {members.map((m) => (
              <label key={m.userId} className="flex items-center gap-1 text-xs text-stone-600">
                <input
                  type="checkbox"
                  name="includes"
                  value={m.userId}
                  defaultChecked={includedIds.includes(m.userId)}
                />
                {m.name ?? m.email}
              </label>
            ))}
          </div>
          <button type="submit" className="text-xs text-stone-500 underline hover:text-stone-700">
            Save
          </button>
        </div>
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
          {locations.map((location) => (
            <LocationRow
              key={location.id}
              tripId={tripId}
              location={location}
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
 * A day's card in the **Agreed** tab -- the settled record of what's
 * actually locked in, laid out the same day-by-day way it's always been.
 * (PlaySpace has its own, leaner day card -- PlaySpaceDayCard.tsx -- for
 * proposing and comparing things that aren't locked yet; this one is
 * read-only on purpose.)
 *
 * The card has exactly one tap target: the header row, which opens the
 * locked-item list. Wake/sleep/stops setup used to sit behind a pencil glyph
 * a few pixels below that row -- a 20x16px target next to a full-width one,
 * opening an entirely different panel when you missed, and unfolding three
 * near-identical location editors inline that shoved the rest of the
 * itinerary down the page. It's now an "Edit wake/sleep and stops" row inside
 * the expanded card, opening a sheet: impossible to hit by accident, and it
 * covers the day rather than displacing it.
 *
 * The wake/sleep summary line is filtered to locations that include
 * the *viewer* -- "my personal view shows me where I'm going to be," not
 * everyone else's leg of a split day (see schema.ts's tripDayLocationMembers
 * for the Bethlehem/NYC example). The sheet shows every location regardless
 * of who's in it, since managing the whole party's plan is still any trip
 * member's job.
 *
 * Day properties stay editable here even though the items aren't -- once
 * locked in, an item is the definition of the agreed plan rather than a
 * proposal, but where people sleep is still a fact about the day.
 */
export default function DayCard({
  tripId,
  day,
  locations,
  locationMembers,
  items,
  timezone,
  members,
  viewerId,
  conflictedItemIds,
}: {
  tripId: string;
  day: TripDay;
  locations: TripDayLocation[];
  locationMembers: Map<string, string[]>;
  /** Locked items for this day only -- callers filter before passing them in (see page.tsx's Agreed tab). */
  items: Item[];
  timezone: string;
  members: TripMemberSummary[];
  viewerId: string;
  conflictedItemIds?: Set<string>;
}) {
  const [itemsOpen, setItemsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

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
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
      >
        <h3 className="text-sm font-semibold text-stone-700">
          <span className="mr-1 inline-block w-3 text-stone-400">{itemsOpen ? "▾" : "▸"}</span>
          {formatCalendarDate(day.date)}
        </h3>
        {/* Only while collapsed -- open, it repeated the very titles listed
            directly beneath it. */}
        {!itemsOpen && <span className="text-right text-sm text-stone-500">{itemsSummary(items)}</span>}
      </button>

      <div className="mt-0.5 pl-[1.35em]">
        <div className="text-xs text-stone-400">
          {/* On a day with nothing at all, the header already says "Nothing
              locked yet" -- a second line saying no locations are set either
              is the same news twice. Both still show when only one is true. */}
          {!hasAnythingForMe && !hasAnythingAtAll && items.length === 0 ? null : !hasAnythingForMe ? (
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
      </div>

      {itemsOpen && (
        <div className="mt-4 space-y-3 border-t border-stone-100 pt-4">
          {items.length === 0 ? (
            <p className="text-sm text-stone-400">Nothing locked in for this day yet.</p>
          ) : (
            <ItemList
              tripId={tripId}
              items={items}
              timezone={timezone}
              hideStatus
              conflictedItemIds={conflictedItemIds}
            />
          )}
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="inline-flex min-h-11 items-center text-sm text-stone-500 underline hover:text-stone-800"
          >
            Edit wake/sleep and stops
          </button>
        </div>
      )}

      <Sheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title={formatCalendarDate(day.date)}
        description="Where everyone wakes, sleeps, and stops on this day."
      >
        <div className="space-y-5">
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
      </Sheet>
    </div>
  );
}
