"use client";

import { useRef, useState } from "react";
import RestaurantSearch, { type PlaceDetails } from "./RestaurantSearch.tsx";
import CuisineLookupButton, { type CuisineResult } from "./CuisineLookupButton.tsx";
import { DIETARY_TAGS, DIETARY_TAG_LABEL, type DietaryTag } from "@/lib/dietary.ts";
import type { DiningDetails } from "@/lib/dining.ts";
import type { TripMemberSummary } from "@/lib/scope.ts";

const PRICE_RANGES = ["$", "$$", "$$$", "$$$$"] as const;

type Prefill = {
  version: number;
  locationName: string;
  contactPhone: string;
  reservationUrl: string;
  priceRange: "" | (typeof PRICE_RANGES)[number];
  placeId: string;
  cuisine: string;
  accommodates: DietaryTag[];
};

function priceRangeFromLevel(level: number | null): Prefill["priceRange"] {
  if (level == null || level < 1 || level > 4) return "";
  return PRICE_RANGES[level - 1];
}

/**
 * The edit-side counterpart to AddItemForm's dining block — same
 * search-and-confirm (Places) then look-up (Claude web search) flow,
 * previously only available at creation time. Extracted into its own
 * component because it needs the same key-remount prefill trick and local
 * state that made AddItemForm's version too tangled to keep inline on the
 * item detail page (a Server Component).
 *
 * The item's title (for the cuisine lookup query) isn't part of this form —
 * it lives in the separate "Edit" section below — so it's passed in as a
 * prop rather than read off a ref the way AddItemForm does it.
 */
export default function DiningEditForm({
  action,
  itemTitle,
  destination,
  dining,
  members,
}: {
  action: (formData: FormData) => void;
  itemTitle: string;
  destination: string;
  dining: DiningDetails | null;
  members: TripMemberSummary[];
}) {
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const locationName = prefill?.locationName ?? "";
  const contactPhone = prefill ? prefill.contactPhone : (dining?.contactPhone ?? "");
  const reservationUrl = prefill ? prefill.reservationUrl : (dining?.reservationUrl ?? "");
  const priceRange = prefill ? prefill.priceRange : (dining?.priceRange ?? "");
  const placeId = prefill ? prefill.placeId : (dining?.placeId ?? "");
  const cuisine = prefill ? prefill.cuisine : (dining?.cuisine ?? "");
  const accommodates = prefill ? prefill.accommodates : (dining?.accommodates ?? []);

  function onRestaurantConfirmed(details: PlaceDetails, matchedPlaceId: string) {
    setPrefill((prev) => ({
      version: (prev?.version ?? 0) + 1,
      locationName: details.formattedAddress ?? "",
      contactPhone: details.phone ?? "",
      reservationUrl: details.website ?? "",
      priceRange: priceRangeFromLevel(details.priceLevel),
      placeId: matchedPlaceId,
      // A new match supersedes any earlier cuisine/dietary guess.
      cuisine: "",
      accommodates: [],
    }));
  }

  function onCuisineResult(result: CuisineResult) {
    setPrefill((prev) => ({
      version: (prev?.version ?? 0) + 1,
      locationName: prev?.locationName ?? locationName,
      contactPhone: prev?.contactPhone ?? contactPhone,
      reservationUrl: prev?.reservationUrl ?? reservationUrl,
      priceRange: prev?.priceRange ?? priceRange,
      placeId: prev?.placeId ?? placeId,
      cuisine: result.cuisine ?? "",
      accommodates: result.accommodates,
    }));
  }

  const version = prefill?.version ?? 0;

  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-2 rounded-md border border-stone-100 bg-stone-50 p-3">
        <p className="text-xs font-medium text-stone-500">Re-search to refresh details from Google/AI (optional)</p>
        <RestaurantSearch destination={destination} onConfirm={onRestaurantConfirmed} />
        <input
          ref={titleRef}
          type="hidden"
          value={itemTitle}
          readOnly
        />
        <CuisineLookupButton
          nameRef={titleRef}
          address={locationName || null}
          onResult={onCuisineResult}
        />
      </div>

      <input key={`placeId-${version}`} type="hidden" name="placeId" defaultValue={placeId} />

      <input
        key={`cuisine-${version}`}
        name="cuisine"
        defaultValue={cuisine}
        placeholder="Cuisine (e.g. Neapolitan pizza)"
        className="input"
      />
      <div key={`accommodates-${version}`}>
        <p className="mb-1 text-xs text-stone-500">Accommodates</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {DIETARY_TAGS.map((tag) => (
            <label key={tag} className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                name="accommodates"
                value={tag}
                defaultChecked={accommodates.includes(tag)}
              />
              {DIETARY_TAG_LABEL[tag]}
            </label>
          ))}
        </div>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <input
          name="partySize"
          type="number"
          min={1}
          step={1}
          defaultValue={dining?.partySize ?? ""}
          placeholder="Party size"
          className="input"
        />
        <select key={`priceRange-${version}`} name="priceRange" defaultValue={priceRange} className="input">
          <option value="">Price</option>
          {PRICE_RANGES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          key={`contactPhone-${version}`}
          name="contactPhone"
          defaultValue={contactPhone}
          placeholder="Restaurant phone"
          className="input"
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <input
          name="confirmationNumber"
          defaultValue={dining?.confirmationNumber ?? ""}
          placeholder="Confirmation number"
          className="input"
        />
        <select name="reservedBy" defaultValue={dining?.reservedBy ?? ""} className="input">
          <option value="">Reserved under (optional)</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name ?? m.email}
            </option>
          ))}
        </select>
      </div>
      <input
        key={`reservationUrl-${version}`}
        name="reservationUrl"
        type="url"
        defaultValue={reservationUrl}
        placeholder="Reservation link (optional)"
        className="input"
      />
      <textarea
        name="specialRequests"
        defaultValue={dining?.specialRequests ?? ""}
        placeholder="Special requests (optional) — high chair, occasion, etc."
        className="input"
        rows={2}
      />
      <button className="btn-secondary justify-self-start">Save dining details</button>
    </form>
  );
}
