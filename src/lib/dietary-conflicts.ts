import type { DietaryTag } from "./dietary.ts";
import type { TripMemberSummary } from "./scope.ts";

export type DietaryFinding = {
  itemId: string;
  itemTitle: string;
  member: TripMemberSummary;
  unmetTags: DietaryTag[];
};

/**
 * Cross-references what a dining item accommodates against one attendee's
 * own disclosed restrictions.
 *
 * A null/empty `accommodates` means the item hasn't been analyzed yet — same
 * "unanalyzable, not an error" philosophy as a missing location in
 * conflicts.ts — and must never be read as "accommodates nothing." A member
 * with no restrictions of their own trivially never triggers a finding,
 * whether or not the item's been analyzed.
 *
 * Pure and deterministic on purpose, same reasoning as conflicts.ts's
 * analyzeTimeline: this decides the fact, an LLM (later) only gets to
 * narrate it.
 */
export function checkDietaryFit(
  item: { id: string; title: string },
  accommodates: DietaryTag[] | null,
  member: TripMemberSummary,
): DietaryFinding | null {
  if (!accommodates || accommodates.length === 0) return null;
  if (!member.dietaryRestrictions || member.dietaryRestrictions.length === 0) return null;

  const covered = new Set(accommodates);
  const unmetTags = member.dietaryRestrictions.filter((tag) => !covered.has(tag));
  if (unmetTags.length === 0) return null;

  return { itemId: item.id, itemTitle: item.title, member, unmetTags };
}

/** All findings for one item across a set of attendees, in member order. */
export function checkDietaryFitForItem(
  item: { id: string; title: string },
  accommodates: DietaryTag[] | null,
  attendees: TripMemberSummary[],
): DietaryFinding[] {
  return attendees
    .map((member) => checkDietaryFit(item, accommodates, member))
    .filter((f): f is DietaryFinding => f !== null);
}
