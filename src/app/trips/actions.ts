"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { createTrip } from "@/lib/trips.ts";
import { updateProfile } from "@/lib/profile.ts";
import { acceptTypedTimezone, timezoneForPlace } from "@/lib/timezone.ts";

/**
 * Which zone this trip's times mean, in order of how much we trust it:
 *
 * 1. What the form sent -- either the zone the client resolved from the
 *    destination, or one somebody typed by hand after clicking "change". A
 *    bare abbreviation is refused rather than resolved: "EST" means
 *    America/Panama to Intl, which is not what anyone typing it means (see
 *    timezone.ts's acceptTypedTimezone).
 * 2. A server-side lookup from the destination. This is the no-JavaScript
 *    path: without the client component there's no hidden field at all.
 * 3. UTC, so an unreachable Maps API can't stop somebody making a trip.
 *
 * This field used to be a required text input prefilled with
 * `America/Mexico_City` regardless of where the trip was going, which meant
 * every time on a trip whose planner didn't notice was silently wrong.
 */
async function resolveTimezone(submitted: string, destination: string): Promise<string> {
  if (submitted.trim()) {
    const typed = acceptTypedTimezone(submitted);
    if (!typed.ok) throw new Error(typed.reason);
    return typed.id;
  }

  const derived = destination.trim() ? await timezoneForPlace(destination) : null;
  return derived ?? "UTC";
}

export async function createTripAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  // Only present when the creator has no name yet -- see NewTripPage. Saved
  // before the trip so that a failed create doesn't throw the answer away, and
  // so "invited by" on the very first invite already reads as a person.
  const name = String(formData.get("name.self") ?? "").trim();
  if (name && !user.name?.trim()) await updateProfile(user, { name });

  let tripId: string;
  try {
    const destination = String(formData.get("destination") ?? "");
    const trip = await createTrip(user, {
      name: String(formData.get("name") ?? ""),
      destination,
      startDate: String(formData.get("startDate") ?? ""),
      endDate: String(formData.get("endDate") ?? ""),
      timezone: await resolveTimezone(String(formData.get("timezone") ?? ""), destination),
    });
    tripId = trip.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create the trip.";
    redirect(`/trips/new?error=${encodeURIComponent(message)}`);
  }

  // PlaySpace, not the default Agreed tab: a trip seconds old has nothing
  // locked by definition, so Agreed could only greet its creator with one
  // "Nothing locked yet" row per day and no way to change that. PlaySpace is
  // where the first idea actually goes.
  redirect(`/trip/${tripId}?tab=playspace`);
}
