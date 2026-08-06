"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { requireUser } from "@/lib/auth.ts";
import { updateProfile, RuleError } from "@/lib/profile.ts";
import type { DietaryTag } from "@/lib/dietary.ts";

function withError(err: unknown): never {
  const message = err instanceof RuleError || err instanceof Error ? err.message : "Something went wrong.";
  redirect(`/profile?error=${encodeURIComponent(message)}` as Route);
}

export async function updateProfileAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim() || null;
  const dietaryRestrictions = formData.getAll("dietaryRestrictions") as DietaryTag[];
  const dietaryNotes = String(formData.get("dietaryNotes") ?? "").trim() || null;

  try {
    await updateProfile(user, { name, dietaryRestrictions, dietaryNotes });
  } catch (err) {
    withError(err);
  }

  // Every page here reads cookies() (session), which already makes Next
  // render them fully dynamically on every request -- and the app navigates
  // with plain <a> tags, not next/link, so there's no client router cache to
  // worry about either. A trip's People list will show the new value on its
  // very next load with no extra revalidation needed.
  revalidatePath("/profile");
  redirect("/profile?saved=1" as Route);
}
