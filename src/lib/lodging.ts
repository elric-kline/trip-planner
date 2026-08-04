import { eq } from "drizzle-orm";
import { db } from "@/db";
import { lodgingDetails } from "@/db/schema";
import { canEditItem, getItem, type TripAccess } from "./scope.ts";
import { RuleError } from "./items.ts";

export type LodgingDetails = typeof lodgingDetails.$inferSelect;
export type LodgingPaymentStatus = NonNullable<LodgingDetails["paymentStatus"]>;

export type LodgingDetailsInput = {
  address?: string | null;
  checkInInstructions?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  confirmationNumber?: string | null;
  bookedBy?: string | null;
  paymentStatus?: LodgingPaymentStatus | null;
  bookingUrl?: string | null;
  cancellationDeadline?: Date | null;
  costAmount?: number | null;
  costCurrency?: string | null;
};

/** Null when the item has no lodging details yet — not every lodging item will right away. */
export async function getLodgingDetails(itemId: string): Promise<LodgingDetails | null> {
  const [row] = await db
    .select()
    .from(lodgingDetails)
    .where(eq(lodgingDetails.itemId, itemId))
    .limit(1);
  return row ?? null;
}

/**
 * Create-or-replace, gated by the same edit rule as the item itself
 * (`canEditItem`) rather than the page-level "not locked" restriction the
 * base title/notes edit form imposes. Booking details are exactly the thing
 * that gets corrected or filled in *after* an item locks — a late
 * confirmation number, a corrected check-in code — so a planner keeps the
 * ability to update them post-lock even though the item's own fields freeze.
 */
export async function upsertLodgingDetails(
  access: TripAccess,
  itemId: string,
  input: LodgingDetailsInput,
): Promise<LodgingDetails> {
  const item = await getItem(access, itemId);
  if (!canEditItem(access, item))
    throw new RuleError("You can't edit this item's details.");
  if (item.category !== "lodging")
    throw new RuleError("Only lodging items can have lodging details.");

  if (input.bookedBy && !access.members.some((m) => m.userId === input.bookedBy)) {
    throw new RuleError("Booked under must be someone on the trip.");
  }

  const [row] = await db
    .insert(lodgingDetails)
    .values({ itemId, ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: lodgingDetails.itemId,
      set: { ...input, updatedAt: new Date() },
    })
    .returning();

  return row;
}
