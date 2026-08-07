import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { diningDetails } from "@/db/schema";
import { canEditItem, getItem, type TripAccess } from "./scope.ts";
import { RuleError } from "./items.ts";
import type { DietaryTag } from "./dietary.ts";

export type DiningDetails = typeof diningDetails.$inferSelect;
export type DiningPriceRange = NonNullable<DiningDetails["priceRange"]>;

export type DiningDetailsInput = {
  placeId?: string | null;
  cuisine?: string | null;
  /** What the venue can accommodate — see schema.ts's diningDetails doc for why null/empty means "not analyzed," not "nothing." */
  accommodates?: DietaryTag[] | null;
  partySize?: number | null;
  priceRange?: DiningPriceRange | null;
  reservedBy?: string | null;
  confirmationNumber?: string | null;
  contactPhone?: string | null;
  reservationUrl?: string | null;
  specialRequests?: string | null;
};

/** Null when the item has no dining details yet — not every dining item will right away. */
export async function getDiningDetails(itemId: string): Promise<DiningDetails | null> {
  const [row] = await db
    .select()
    .from(diningDetails)
    .where(eq(diningDetails.itemId, itemId))
    .limit(1);
  return row ?? null;
}

/** Batched lookup so a trip-wide dietary check doesn't issue one query per dining item. */
export async function getDiningDetailsForItems(itemIds: string[]): Promise<Map<string, DiningDetails>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.select().from(diningDetails).where(inArray(diningDetails.itemId, itemIds));
  return new Map(rows.map((row) => [row.itemId, row]));
}

/**
 * Create-or-replace, gated by the same edit rule as the item itself
 * (`canEditItem`) rather than the page-level "not locked" restriction the
 * base title/notes edit form imposes — same reasoning as lodging: a
 * confirmation number or a corrected reservation time is exactly the sort of
 * thing that gets fixed after the item locks.
 */
export async function upsertDiningDetails(
  access: TripAccess,
  itemId: string,
  input: DiningDetailsInput,
): Promise<DiningDetails> {
  const item = await getItem(access, itemId);
  if (!canEditItem(access, item))
    throw new RuleError("You can't edit this item's details.");
  if (item.category !== "dining")
    throw new RuleError("Only dining items can have dining details.");

  if (input.reservedBy && !access.members.some((m) => m.userId === input.reservedBy)) {
    throw new RuleError("Reserved under must be someone on the trip.");
  }
  if (input.partySize != null && (!Number.isInteger(input.partySize) || input.partySize < 1)) {
    throw new RuleError("Party size must be a positive whole number.");
  }

  const values = {
    ...input,
    accommodates: input.accommodates?.length ? input.accommodates : null,
  };

  const [row] = await db
    .insert(diningDetails)
    .values({ itemId, ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: diningDetails.itemId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();

  return row;
}
