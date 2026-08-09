"use client";

import { useState } from "react";
import { createItemAction } from "./actions.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";

type Category = "lodging" | "dining" | "activity" | "transport" | "other";
const TRANSPORT_SUBTYPES = ["flight", "train", "drive", "rideshare", "other"] as const;
const TRANSPORT_SUBTYPE_LABEL: Record<(typeof TRANSPORT_SUBTYPES)[number], string> = {
  flight: "Flight",
  train: "Train",
  drive: "Drive",
  rideshare: "Rideshare",
  other: "Other",
};

/**
 * What it takes to *propose* something: what it is, where, and when.
 *
 * Booking paperwork deliberately isn't here. Choosing "Lodging" used to unfold
 * an address, check-in instructions, three contact fields, a confirmation
 * number, booked-by, payment status, cost, currency, a cancellation deadline
 * and a booking URL between you and the Add button -- and Dining and Transport
 * did the same. Nobody has a confirmation number for a restaurant they're
 * still suggesting; those are fields for after a decision, and they already
 * live on the item's own page, which is reachable the moment the item exists.
 *
 * Transport's subtype is the exception, and stays. It isn't paperwork: it
 * picks the buffer the conflict checker widens the item by (see
 * transport-buffer.ts), and drive/rideshare use the stops on either side of
 * the gap to fill in where the trip starts and ends.
 */
export default function AddItemForm({
  tripId,
  visibility,
  dayId,
  afterItemId,
  precedingLocationName,
  followingLocationName,
  onCancel,
}: {
  tripId: string;
  /**
   * Which tab this add lands in -- required, not a checkbox, because where you
   * opened the form from already answers the question: PlaySpace (and a day's
   * own "+ Add," which only ever shows up inside PlaySpace's timeline) is
   * always "group"; Scratchpad is always "private."
   */
  visibility: "private" | "group";
  /** Set when opened from a day's own "+ Add" slot (see DayItemBuilder.tsx) -- omitted for a tab-level add, which creates a dayless item. */
  dayId?: string;
  /** Where in that day's draft order to insert -- omitted appends to the end. Ignored once the item gets a startsAt, which always governs order instead. */
  afterItemId?: string;
  /**
   * The items immediately before/after the gap this form was opened in --
   * only set for a between-two-items "+ Add" (see DayItemBuilder.tsx), never
   * for the always-visible end-of-day slot (nothing follows an append) or
   * a tab-level add (no adjacent items at all). Prefills Location/
   * Destination when the subtype is drive or rideshare: a car ride that's
   * literally the gap between two stops starts and ends exactly where
   * they are, same reasoning as the item's own door-to-door startsAt/endsAt.
   * A train needs an actual station, not an item's address, so it's left
   * out of the auto-fill even though the field itself is still there.
   */
  precedingLocationName?: string | null;
  followingLocationName?: string | null;
  /** Dismisses the sheet this form is rendered in (see AddItemSheet.tsx). */
  onCancel?: () => void;
}) {
  const [category, setCategory] = useState<Category>("activity");
  const [transportSubtype, setTransportSubtype] = useState<(typeof TRANSPORT_SUBTYPES)[number]>("other");
  const isLodging = category === "lodging";
  const isTransport = category === "transport";
  const autoFillsFromGap = isTransport && (transportSubtype === "drive" || transportSubtype === "rideshare");

  return (
    <form action={createItemAction.bind(null, tripId)} className="grid gap-3">
      {dayId && <input type="hidden" name="dayId" value={dayId} />}
      {afterItemId && <input type="hidden" name="afterItemId" value={afterItemId} />}
      {visibility === "private" && <input type="hidden" name="private" value="on" />}

      <input name="title" required placeholder="Title" className="input" autoFocus />
      <div className="grid gap-3 sm:grid-cols-2">
        <select
          name="category"
          className="input"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
        >
          <option value="lodging">Lodging</option>
          <option value="dining">Dining</option>
          <option value="activity">Activity</option>
          <option value="transport">Transport</option>
          <option value="other">Other</option>
        </select>
        <AddressAutocomplete
          key={`location-${isTransport ? transportSubtype : ""}`}
          name="locationName"
          defaultValue={autoFillsFromGap ? (precedingLocationName ?? undefined) : undefined}
          placeholder="Location (optional)"
          className="input"
        />
      </div>
      <p className="-mt-1 text-sm text-stone-500">
        We&apos;ll look up coordinates from the location automatically — that&apos;s what lets the conflict
        checker estimate travel time between stops.
      </p>
      <textarea name="notes" placeholder="Notes (optional)" className="input" rows={2} />

      {isTransport && (
        <div className="grid gap-3 rounded-md border border-stone-100 bg-stone-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <select
              name="subtype"
              className="input"
              value={transportSubtype}
              onChange={(e) => setTransportSubtype(e.target.value as typeof transportSubtype)}
            >
              {TRANSPORT_SUBTYPES.map((s) => (
                <option key={s} value={s}>
                  {TRANSPORT_SUBTYPE_LABEL[s]}
                </option>
              ))}
            </select>
            {transportSubtype === "flight" && (
              <label className="flex min-h-11 items-center gap-2 text-sm text-stone-700">
                <input type="checkbox" name="international" />
                International
              </label>
            )}
          </div>
          {transportSubtype !== "flight" && (
            <>
              <AddressAutocomplete
                key={`destination-${transportSubtype}`}
                name="destinationName"
                defaultValue={autoFillsFromGap ? (followingLocationName ?? undefined) : undefined}
                placeholder="Destination (optional)"
                className="input"
              />
              <p className="-mt-2 text-sm text-stone-500">
                {autoFillsFromGap
                  ? "Filled in from the stops on either side of this gap — adjust if this isn't a direct trip between them."
                  : "Where this trip ends up, if different from Location — lets the conflict checker estimate travel from here, not from where it started."}
              </p>
            </>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">{isLodging ? "Arrival (optional)" : "Starts (optional)"}</span>
          <input type="datetime-local" name="startsAt" className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">{isLodging ? "Departure (optional)" : "Ends (optional)"}</span>
          <input type="datetime-local" name="endsAt" className="input" />
        </label>
      </div>

      <p className="-mt-1 text-sm text-stone-500">
        Booking details — confirmation numbers, cost, check-in instructions — go on the item&apos;s own page
        once it exists.
      </p>

      <div className="mt-1 flex items-center gap-3">
        <button type="submit" className="btn-primary">
          Add
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-11 items-center text-sm text-stone-500 hover:text-stone-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
