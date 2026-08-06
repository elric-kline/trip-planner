import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dietaryTag, users } from "@/db/schema";
import type { CurrentUser } from "./auth.ts";

export class RuleError extends Error {}

export type DietaryTag = (typeof dietaryTag.enumValues)[number];

/** The actual enum values, in the order shown as checkboxes -- see profile/page.tsx. */
export const DIETARY_TAGS: DietaryTag[] = [...dietaryTag.enumValues];

/** Shared between the profile edit form and anywhere else tags are displayed (the trip People list). */
export const DIETARY_TAG_LABEL: Record<DietaryTag, string> = {
  vegetarian: "Vegetarian",
  vegan: "Vegan",
  pescatarian: "Pescatarian",
  gluten_free: "Gluten-free",
  dairy_free: "Dairy-free",
  nut_free: "Nut-free",
  shellfish_free: "Shellfish-free",
  halal: "Halal",
  kosher: "Kosher",
  low_carb: "Low-carb",
};

export type ProfileInput = {
  name?: string | null;
  dietaryRestrictions?: DietaryTag[];
  dietaryNotes?: string | null;
};

export type Profile = {
  name: string | null;
  email: string;
  dietaryRestrictions: DietaryTag[] | null;
  dietaryNotes: string | null;
};

export async function getProfile(userId: string): Promise<Profile> {
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      dietaryRestrictions: users.dietaryRestrictions,
      dietaryNotes: users.dietaryNotes,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new RuleError("Profile not found.");
  return row;
}

/**
 * A user only ever edits their own profile -- there's no "edit someone
 * else's dietary info" path, unlike item edits which go through TripAccess.
 * Dietary info is global (not per-trip) and, once set, is visible to
 * co-members on any trip via TripMemberSummary (see scope.ts) -- that's the
 * "optional to disclose" in practice: setting it here *is* disclosing it.
 */
export async function updateProfile(
  viewer: CurrentUser,
  input: ProfileInput,
): Promise<void> {
  if (input.dietaryRestrictions) {
    const known = new Set<string>(dietaryTag.enumValues);
    for (const tag of input.dietaryRestrictions) {
      if (!known.has(tag)) throw new RuleError(`"${tag}" isn't a recognized dietary tag.`);
    }
  }

  await db
    .update(users)
    .set({
      // Name is optional -- nothing else in the app requires one (every
      // display falls back to email, e.g. TripMemberSummary usage), and
      // magic-link signup never asks for one either. A blank submission
      // just clears it, same as any other optional text field here.
      ...(input.name !== undefined ? { name: input.name?.trim() || null } : {}),
      ...(input.dietaryRestrictions !== undefined
        ? { dietaryRestrictions: input.dietaryRestrictions.length ? input.dietaryRestrictions : null }
        : {}),
      ...(input.dietaryNotes !== undefined ? { dietaryNotes: input.dietaryNotes?.trim() || null } : {}),
    })
    .where(eq(users.id, viewer.id));
}
