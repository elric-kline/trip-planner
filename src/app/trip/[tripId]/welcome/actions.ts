"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { updateProfile } from "@/lib/profile.ts";

/**
 * Saves just the name, then gets out of the way. Deliberately not
 * updateProfileAction: that one also writes dietary fields and redirects back
 * to the profile page, neither of which belongs in the middle of joining a
 * trip.
 */
export async function saveNameAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();

  // A blank submit is the same as skipping -- no point erroring at somebody
  // over an optional field.
  if (name) await updateProfile(user, { name });

  redirect(`/trip/${tripId}`);
}
