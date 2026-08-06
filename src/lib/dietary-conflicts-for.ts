import { attendanceFor } from "./attendance.ts";
import { checkDietaryFitForItem, type DietaryFinding } from "./dietary-conflicts.ts";
import { getDiningDetailsForItems } from "./dining.ts";
import { listItems, type Item, type TripAccess } from "./scope.ts";
import type { DietaryTag } from "./dietary.ts";

/**
 * Every locked dining item's accommodations checked against its actual
 * attendees' own disclosed restrictions — same "only locked items" scope as
 * the travel-time conflict checker (conflicts-for.ts): commitment and
 * attendance aren't settled before then, so there's nothing stable to check
 * yet. `attendanceFor` already keeps this privacy-safe — a private item's
 * only "attendee" is its own author.
 */
export async function dietaryWarningsForViewer(access: TripAccess): Promise<DietaryFinding[]> {
  const items = await listItems(access, { status: "locked" });
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
  if (item.category !== "dining" || item.status !== "locked" || !accommodates?.length) return [];
  const attendance = await attendanceFor(access, item);
  return checkDietaryFitForItem(item, accommodates, attendance.attendees);
}
