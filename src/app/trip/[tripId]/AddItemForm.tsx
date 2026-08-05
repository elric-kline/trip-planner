"use client";

import { useState } from "react";
import { createItemAction } from "./actions.ts";
import type { TripMemberSummary } from "@/lib/scope.ts";

type Category = "lodging" | "dining" | "activity" | "transport" | "other";

/**
 * Extension point: as other categories grow their own structured fields
 * (dining reservation details, transport confirmation numbers, etc.), give
 * them a `<CategoryFields>`-style block below, gated the same way Lodging's
 * is. Category is local component state so the fields can react to the
 * dropdown immediately, before the item even exists.
 */
export default function AddItemForm({
  tripId,
  members,
}: {
  tripId: string;
  members: TripMemberSummary[];
}) {
  const [category, setCategory] = useState<Category>("activity");
  const isLodging = category === "lodging";

  return (
    <form action={createItemAction.bind(null, tripId)} className="grid gap-3 rounded-md border border-stone-200 bg-white p-4">
      <div className="grid grid-cols-2 gap-3">
        <input name="title" required placeholder="Title" className="input col-span-2" />
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
        <input name="locationName" placeholder="Location (optional)" className="input" />
      </div>
      <p className="text-xs text-stone-400">
        We'll look up coordinates from the location automatically — that's what lets the conflict checker estimate travel time between stops.
      </p>
      <textarea name="notes" placeholder="Notes (optional)" className="input" rows={2} />

      {isLodging && (
        <div className="grid gap-3 rounded-md border border-stone-100 bg-stone-50 p-3">
          <p className="text-xs font-medium text-stone-500">Lodging details (optional — fill in now or later)</p>
          <input name="address" placeholder="Address" className="input" />
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
      <button type="submit" className="btn-primary justify-self-start">
        Add
      </button>
    </form>
  );
}
