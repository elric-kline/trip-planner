"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { requireUser } from "@/lib/auth.ts";
import { updateProfile, RuleError as ProfileRuleError } from "@/lib/profile.ts";
import {
  updatePassportDetails,
  updatePassportPhoto,
  removePassportPhoto,
  removePassportDetails,
  RuleError as PassportRuleError,
} from "@/lib/passport.ts";
import type { DietaryTag } from "@/lib/dietary.ts";

function withError(err: unknown): never {
  const message =
    err instanceof ProfileRuleError || err instanceof PassportRuleError || err instanceof Error
      ? err.message
      : "Something went wrong.";
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

/**
 * One form, one submit, for both the text fields and an optional photo --
 * same "everything in one FormData" shape as the lodging/dining detail
 * forms elsewhere. An empty text field means "leave it as-is" (matches
 * updatePassportDetails' own per-field `undefined` vs `null` distinction),
 * so re-saving the photo alone doesn't require re-typing a passport number.
 */
export async function updatePassportAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const str = (name: string) => {
    const raw = formData.get(name);
    if (raw == null) return undefined;
    const trimmed = String(raw).trim();
    return trimmed || null;
  };

  try {
    await updatePassportDetails(user, {
      fullName: str("fullName"),
      passportNumber: str("passportNumber"),
      nationality: str("nationality"),
      dateOfBirth: str("dateOfBirth"),
      expiryDate: str("expiryDate"),
    });

    const photo = formData.get("photo");
    if (photo instanceof File && photo.size > 0) {
      const bytes = Buffer.from(await photo.arrayBuffer());
      await updatePassportPhoto(user, bytes, photo.type);
    }
  } catch (err) {
    withError(err);
  }

  revalidatePath("/profile");
  redirect("/profile?saved=1" as Route);
}

export async function removePassportPhotoAction(): Promise<void> {
  const user = await requireUser();
  await removePassportPhoto(user);
  revalidatePath("/profile");
  redirect("/profile?saved=1" as Route);
}

export async function removePassportDetailsAction(): Promise<void> {
  const user = await requireUser();
  await removePassportDetails(user);
  revalidatePath("/profile");
  redirect("/profile?saved=1" as Route);
}
