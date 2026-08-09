import { attendanceFor } from "./attendance.ts";
import { checkDietaryFitForItem, type DietaryFinding } from "./dietary-conflicts.ts";
import { getDiningDetailsForItems } from "./dining.ts";
import { listItems, type Item, type TripAccess } from "./scope.ts";
import type { DietaryTag } from "./dietary.ts";

/**
 * Every proposed or locked dining item's accommodations checked against its
 * actual attendees' own disclosed restrictions -- same scope as the
 * travel-time checker (conflicts-for.ts). Both used to be locked-only, on the
 * reasoning that attendance wasn't settled before then; it is now, because an
 * "I'm in" counts on a proposal (see lifecycle.ts's checkRsvp).
 *
 * Pre-lock is where this warning is actually worth something: "that place
 * doesn't do gluten-free and two people who want to go need it" is useful
 * while you can still pick somewhere else, and merely annoying once the table
 * is booked. `attendanceFor` keeps it privacy-safe -- a private item's only
 * "attendee" is its own author.
 */
export async function dietaryWarningsForViewer(access: TripAccess): Promise<DietaryFinding[]> {
  const items = await listItems(access, { status: ["proposed", "locked"] });
  const diningItems = items.filter((i) => i.category === "dining");
  if (diningItems.length === 0) return [];

  const detailsByItem = await getDiningDetailsForItems(diningItems.map((i) => i.id));

  const findings: DietaryFinding[] = [];
  for (const item of diningItems) {
    const accommodates = detailsByItem.get(item.id)?.accommodates ?? null;
    if (!accommodates?.length) continue;

    const attendance = await attendanceFor(access, item);
    findings.push(...checkDietaryFitForItem(item, accommodates, attendance.attendees));
  }

  return findings;
}

/** Just one item's findings — what the item detail page shows next to its own dining details. */
export async function dietaryWarningsForItem(
  access: TripAccess,
  item: Item,
  accommodates: DietaryTag[] | null,
): Promise<DietaryFinding[]> {
  const schedulable = item.status === "proposed" || item.status === "locked";
  if (item.category !== "dining" || !schedulable || !accommodates?.length) return [];
  const attendance = await attendanceFor(access, item);
  return checkDietaryFitForItem(item, accommodates, attendance.attendees);
}
