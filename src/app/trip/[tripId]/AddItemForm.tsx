"use client";

import { useRef, useState } from "react";
import { createItemAction } from "./actions.ts";
import AddressAutocomplete from "./AddressAutocomplete.tsx";
import RestaurantSearch, { type PlaceDetails } from "./RestaurantSearch.tsx";
import CuisineLookupButton, { type CuisineResult } from "./CuisineLookupButton.tsx";
import type { TripMemberSummary } from "@/lib/scope.ts";
import { DIETARY_TAGS, DIETARY_TAG_LABEL, type DietaryTag } from "@/lib/dietary.ts";

type Category = "lodging" | "dining" | "activity" | "transport" | "other";
const PRICE_RANGES = ["$", "$$", "$$$", "$$$$"] as const;

type DiningPrefill = {
  version: number;
  title: string;
  locationName: string;
  contactPhone: string;
  reservationUrl: string;
  priceRange: "" | (typeof PRICE_RANGES)[number];
  placeId: string;
  cuisine: string;
  accommodates: DietaryTag[];
};

/** Google's price_level is 0 (free) - 4 (very expensive); 1-4 map onto our $-$$$$ scale, 0/missing stays unset. */
function priceRangeFromLevel(level: number | null): DiningPrefill["priceRange"] {
  if (level == null || level < 1 || level > 4) return "";
  return PRICE_RANGES[level - 1];
}

/**
 * Extension point: as other categories grow their own structured fields
 * (dining reservation details, transport confirmation numbers, etc.), give
 * them a `<CategoryFields>`-style block below, gated the same way Lodging's
 * is. Category is local component state so the fields can react to the
 * dropdown immediately, before the item even exists.
 */
export default function AddItemForm({
  tripId,
  destination,
  members,
  dayId,
  afterItemId,
  onCancel,
}: {
  tripId: string;
  destination: string;
  members: TripMemberSummary[];
  /** Set when opened from a day's own "+ Add" slot (see DayItemBuilder.tsx) -- omitted for the trip-wide "Add something" form, which creates an ungrounded idea same as always. */
  dayId?: string;
  /** Where in that day's draft order to insert -- omitted appends to the end. Ignored once the item gets a startsAt, which always governs order instead. */
  afterItemId?: string;
  /** Shown next to Add only for the compact, day-scoped form -- the standalone bottom-of-page form has nothing to collapse back into. */
  onCancel?: () => void;
}) {
  const [category, setCategory] = useState<Category>("activity");
  const [diningPrefill, setDiningPrefill] = useState<DiningPrefill | null>(null);
  const [titleHasValue, setTitleHasValue] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const isLodging = category === "lodging";
  const isDining = category === "dining";

  function onRestaurantConfirmed(details: PlaceDetails, placeId: string) {
    setDiningPrefill((prev) => ({
      version: (prev?.version ?? 0) + 1,
      title: details.name ?? "",
      locationName: details.formattedAddress ?? "",
      contactPhone: details.phone ?? "",
      reservationUrl: details.website ?? "",
      priceRange: priceRangeFromLevel(details.priceLevel),
      placeId,
      // A new match supersedes any earlier cuisine/dietary guess -- don't
      // carry stale info from a different restaurant into this one.
      cuisine: "",
      accommodates: [],
    }));
    setTitleHasValue(Boolean(details.name));
  }

  function onCuisineResult(result: CuisineResult) {
    setDiningPrefill((prev) => ({
      version: (prev?.version ?? 0) + 1,
      title: prev?.title ?? titleRef.current?.value ?? "",
      locationName: prev?.locationName ?? "",
      contactPhone: prev?.contactPhone ?? "",
      reservationUrl: prev?.reservationUrl ?? "",
      priceRange: prev?.priceRange ?? "",
      placeId: prev?.placeId ?? "",
      cuisine: result.cuisine ?? "",
      accommodates: result.accommodates,
    }));
  }

  return (
    <form action={createItemAction.bind(null, tripId)} className="grid gap-3 rounded-md border border-stone-200 bg-white p-4">
      {dayId && <input type="hidden" name="dayId" value={dayId} />}
      {afterItemId && <input type="hidden" name="afterItemId" value={afterItemId} />}
      <div className="grid grid-cols-2 gap-3">
        <input
          key={`title-${diningPrefill?.version ?? 0}`}
          ref={titleRef}
          name="title"
          required
          defaultValue={diningPrefill?.title ?? ""}
          onChange={(e) => setTitleHasValue(e.target.value.trim().length > 0)}
          placeholder="Title"
          className="input col-span-2"
        />
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
          key={`location-${diningPrefill?.version ?? 0}`}
          name="locationName"
          defaultValue={diningPrefill?.locationName}
          placeholder="Location (optional)"
          className="input"
        />
      </div>
      <p className="text-xs text-stone-400">
        We&apos;ll look up coordinates from the location automatically — that&apos;s what lets the conflict checker estimate travel time between stops.
      </p>
      <textarea name="notes" placeholder="Notes (optional)" className="input" rows={2} />

      {isLodging && (
        <div className="grid gap-3 rounded-md border border-stone-100 bg-stone-50 p-3">
          <p className="text-xs font-medium text-stone-500">Lodging details (optional — fill in now or later)</p>
          <AddressAutocomplete name="address" placeholder="Address" className="input" />
          <p className="-mt-2 text-xs text-stone-400">Used for both the map and travel-time conflict checks.</p>
          <textarea
            name="checkInInstructions"
            placeholder="Check-in instructions (e.g. lockbox code, self check-in)"
            className="input"
            rows={2}
          />
          <div className="grid grid-cols-3 gap-3">
            <input name="contactName" placeholder="Contact name (optional)" className="input" />
            <input name="contactPhone" placeholder="Contact phone" className="input" />
            <input name="contactEmail" type="email" placeholder="Contact email" className="input" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input name="confirmationNumber" placeholder="Confirmation number" className="input" />
            <select name="bookedBy" defaultValue="" className="input">
              <option value="">Booked under (optional)</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <select name="paymentStatus" defaultValue="" className="input">
              <option value="">Payment status</option>
              <option value="prepaid">Prepaid</option>
              <option value="partial">Partially paid</option>
              <option value="pay_on_arrival">Pay on arrival</option>
            </select>
            <input name="costAmount" type="number" step="any" placeholder="Cost" className="input" />
            <input name="costCurrency" placeholder="USD" className="input" maxLength={8} />
          </div>
          <label className="text-sm">
            <span className="mb-1 block text-stone-700">Cancel by (optional)</span>
            <input type="datetime-local" name="cancellationDeadline" className="input" />
          </label>
          <input name="bookingUrl" type="url" placeholder="Booking link (optional)" className="input" />
        </div>
      )}

      {isDining && (
        <div className="grid gap-3 rounded-md border border-stone-100 bg-stone-50 p-3">
          <p className="text-xs font-medium text-stone-500">Dining details (optional — fill in now or later)</p>
          <RestaurantSearch destination={destination} onConfirm={onRestaurantConfirmed} />
          <p className="-mt-2 text-xs text-stone-400">
            Confirming a match fills in the title, location, phone, price, and reservation link below — review
            and adjust before saving.
          </p>
          <input
            key={`placeId-${diningPrefill?.version ?? 0}`}
            type="hidden"
            name="placeId"
            defaultValue={diningPrefill?.placeId ?? ""}
          />
          <CuisineLookupButton
            nameRef={titleRef}
            address={diningPrefill?.locationName ?? null}
            disabled={!titleHasValue}
            onResult={onCuisineResult}
          />
          <input
            key={`cuisine-${diningPrefill?.version ?? 0}`}
            name="cuisine"
            defaultValue={diningPrefill?.cuisine ?? ""}
            placeholder="Cuisine (e.g. Neapolitan pizza)"
            className="input"
          />
          <div key={`accommodates-${diningPrefill?.version ?? 0}`}>
            <p className="mb-1 text-xs text-stone-500">Accommodates</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {DIETARY_TAGS.map((tag) => (
                <label key={tag} className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    name="accommodates"
                    value={tag}
                    defaultChecked={diningPrefill?.accommodates?.includes(tag) ?? false}
                  />
                  {DIETARY_TAG_LABEL[tag]}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <input name="partySize" type="number" min={1} step={1} placeholder="Party size" className="input" />
            <select
              key={`priceRange-${diningPrefill?.version ?? 0}`}
              name="priceRange"
              defaultValue={diningPrefill?.priceRange ?? ""}
              className="input"
            >
              <option value="">Price</option>
              {PRICE_RANGES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              key={`contactPhone-${diningPrefill?.version ?? 0}`}
              name="contactPhone"
              defaultValue={diningPrefill?.contactPhone ?? ""}
              placeholder="Restaurant phone"
              className="input"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input name="confirmationNumber" placeholder="Confirmation number" className="input" />
            <select name="reservedBy" defaultValue="" className="input">
              <option value="">Reserved under (optional)</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email}
                </option>
              ))}
            </select>
          </div>
          <input
            key={`reservationUrl-${diningPrefill?.version ?? 0}`}
            name="reservationUrl"
            type="url"
            defaultValue={diningPrefill?.reservationUrl ?? ""}
            placeholder="Reservation link (optional)"
            className="input"
          />
          <textarea
            name="specialRequests"
            placeholder="Special requests (optional) — high chair, occasion, etc."
            className="input"
            rows={2}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">{isLodging ? "Check-in (optional)" : "Starts (optional)"}</span>
          <input type="datetime-local" name="startsAt" className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">{isLodging ? "Check-out (optional)" : "Ends (optional)"}</span>
          <input type="datetime-local" name="endsAt" className="input" />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" name="private" /> Keep this private to me
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary justify-self-start">
          Add
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-sm text-stone-500 hover:text-stone-700">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
