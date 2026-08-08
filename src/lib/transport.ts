import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { transportDetails, transportLegs } from "@/db/schema";
import { canEditItem, getItem, type TripAccess } from "./scope.ts";
import { RuleError, scheduleItem } from "./items.ts";
import { deriveScheduleFromLegs, type TransportSubtype } from "./transport-buffer.ts";

export type { TransportSubtype, TransportBuffer, LayoverFinding } from "./transport-buffer.ts";
export { transportBufferFor, analyzeLegLayovers, deriveScheduleFromLegs } from "./transport-buffer.ts";

export type TransportDetails = typeof transportDetails.$inferSelect;
export type TransportLeg = typeof transportLegs.$inferSelect;

export type TransportDetailsInput = {
  subtype: TransportSubtype;
  international?: boolean | null;
  confirmationNumber?: string | null;
  bookedBy?: string | null;
  bookingUrl?: string | null;
  costAmount?: number | null;
  costCurrency?: string | null;
};

export type TransportLegInput = {
  airline?: string | null;
  flightNumber?: string | null;
  departureAirport?: string | null;
  arrivalAirport?: string | null;
  departsAt: Date;
  arrivesAt: Date;
};

/** Null when the item has no transport details yet -- not every transport item will right away. */
export async function getTransportDetails(itemId: string): Promise<TransportDetails | null> {
  const [row] = await db
    .select()
    .from(transportDetails)
    .where(eq(transportDetails.itemId, itemId))
    .limit(1);
  return row ?? null;
}

/** Empty for anything that isn't a multi-leg flight -- see schema.ts's transportLegs doc for why only "flight" ever has rows here. Ordered by legOrder, the ordering analyzeLegLayovers/deriveScheduleFromLegs both require. */
export async function getTransportLegs(itemId: string): Promise<TransportLeg[]> {
  return db
    .select()
    .from(transportLegs)
    .where(eq(transportLegs.itemId, itemId))
    .orderBy(asc(transportLegs.legOrder));
}

/**
 * Create-or-replace, gated by the same edit rule as the item itself
 * (`canEditItem`) rather than the page-level "not locked" restriction --
 * same reasoning as lodging/dining: a confirmation number or a corrected
 * subtype is exactly the sort of thing that gets fixed after the item
 * locks.
 */
export async function upsertTransportDetails(
  access: TripAccess,
  itemId: string,
  input: TransportDetailsInput,
): Promise<TransportDetails> {
  const item = await getItem(access, itemId);
  if (!canEditItem(access, item))
    throw new RuleError("You can't edit this item's details.");
  if (item.category !== "transport")
    throw new RuleError("Only transport items can have transport details.");

  if (input.bookedBy && !access.members.some((m) => m.userId === input.bookedBy)) {
    throw new RuleError("Booked under must be someone on the trip.");
  }

  const [row] = await db
    .insert(transportDetails)
    .values({ itemId, ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: transportDetails.itemId,
      set: { ...input, updatedAt: new Date() },
    })
    .returning();

  // Subtype moved off "flight" -- any legs it had no longer mean anything,
  // same reasoning as items.ts's updateItemDetails dropping lodging/dining
  // details when an item's category moves away from them.
  if (row.subtype !== "flight") {
    await db.delete(transportLegs).where(eq(transportLegs.itemId, itemId));
  }

  return row;
}

/**
 * Replace-all for a flight's legs, ordered as given -- delete-then-insert
 * rather than a diff, since a re-route (added/removed/reordered
 * connection) is the common case, not a single field edit.
 *
 * Also resyncs the parent item's own startsAt/endsAt to the new
 * first-departure/last-arrival span (see deriveScheduleFromLegs) through
 * the same scheduleItem() the manual "set a time" UI uses -- so legs stay
 * the single source of truth for a flight's slot in the timeline, and the
 * usual lifecycle rule applies: once the item is locked, its time (and so
 * its legs) can't move until a planner unlocks it.
 */
export async function setTransportLegs(
  access: TripAccess,
  itemId: string,
  legs: TransportLegInput[],
): Promise<TransportLeg[]> {
  const item = await getItem(access, itemId);
  if (item.category !== "transport")
    throw new RuleError("Only transport items can have transport legs.");
  if (legs.length === 0) throw new RuleError("Give the flight at least one leg.");

  const details = await getTransportDetails(itemId);
  if (details?.subtype !== "flight")
    throw new RuleError("Only flight-subtype transport items can have legs.");

  for (const leg of legs) {
    if (leg.departsAt >= leg.arrivesAt)
      throw new RuleError("A leg's arrival must come after its departure.");
  }
  for (let i = 0; i < legs.length - 1; i++) {
    if (legs[i].arrivesAt >= legs[i + 1].departsAt)
      throw new RuleError("Each leg must depart after the previous leg arrives.");
  }

  await db.delete(transportLegs).where(eq(transportLegs.itemId, itemId));
  const inserted = await db
    .insert(transportLegs)
    .values(legs.map((leg, legOrder) => ({ itemId, legOrder, ...leg })))
    .returning();
  const sorted = [...inserted].sort((a, b) => a.legOrder - b.legOrder);

  // legs.length > 0 was already checked above, so this is never null here.
  const schedule = deriveScheduleFromLegs(sorted)!;
  await scheduleItem(access, itemId, schedule.startsAt, schedule.endsAt);

  return sorted;
}
