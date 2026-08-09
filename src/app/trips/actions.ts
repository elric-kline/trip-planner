"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { createTrip } from "@/lib/trips.ts";

export async function createTripAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  let tripId: string;
  try {
    const trip = await createTrip(user, {
      name: String(formData.get("name") ?? ""),
      destination: String(formData.get("destination") ?? ""),
      startDate: String(formData.get("startDate") ?? ""),
      endDate: String(formData.get("endDate") ?? ""),
      timezone: String(formData.get("timezone") ?? "UTC"),
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
