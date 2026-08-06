/**
 * Pure, DB-connection-free constants derived from the dietary_tag enum —
 * split out from profile.ts specifically so a client component (the "Add
 * something" form's Dining/Lodging fields) can import the tag list and
 * labels without pulling in profile.ts's `db` import, which drags Node's
 * `postgres` client (and its `fs`/`perf_hooks` dependencies) into the
 * browser bundle and breaks the build. Same lesson as origin.ts vs url.ts
 * and lifecycle.ts vs items.ts: pure logic lives apart from whatever
 * touches the database or a Next.js-only API.
 */
import { dietaryTag } from "@/db/schema";

export type DietaryTag = (typeof dietaryTag.enumValues)[number];

/** The actual enum values, in the order shown as checkboxes wherever they're rendered. */
export const DIETARY_TAGS: DietaryTag[] = [...dietaryTag.enumValues];

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
