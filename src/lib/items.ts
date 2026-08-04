import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { itemRsvps, items, lodgingDetails } from "@/db/schema";
import {
  checkDecline,
  checkLock,
  checkPropose,
  checkRestore,
  checkRsvp,
  checkUnlock,
  checkUnschedule,
  statusForTime,
  type Actor,
  type Check,
  type Commitment,
} from "./lifecycle.ts";
import { canEditItem, getItem, type Item, type TripAccess } from "./scope.ts";

export class RuleError extends Error {}

function enforce(check: Check): void {
  if (!check.ok) throw new RuleError(check.reason);
}

function actorFor(access: TripAccess, item: Item): Actor {
  return { isPlanner: access.isPlanner, isAuthor: item.createdBy === access.viewer.id };
}

const touch = { updatedAt: new Date() };

export type CreateItemInput = {
  title: string;
  notes?: string | null;
  category?: Item["category"];
  locationName?: string | null;
  /** Coordinates are what the conflict engine needs — a name alone isn't enough to estimate travel time. */
  locationLat?: number | null;
  locationLng?: number | null;
  visibility?: Item["visibility"];
  startsAt?: Date | null;
  endsAt?: Date | null;
};

/**
 * Everything enters the system here, as an idea. Supplying a time creates it
 * already promoted to a proposal — the same row either way.
 */
export async function createItem(
  access: TripAccess,
  input: CreateItemInput,
): Promise<Item> {
  const title = input.title.trim();
  if (!title) throw new RuleError("Give the item a title.");
  if (input.endsAt && input.startsAt && input.startsAt >= input.endsAt)
    throw new RuleError("The end time must come after the start time.");

  const [created] = await db
    .insert(items)
    .values({
      tripId: access.trip.id,
      createdBy: access.viewer.id,
      title,
      notes: input.notes?.trim() || null,
      category: input.category ?? "activity",
      locationName: input.locationName?.trim() || null,
      locationLat: input.locationLat ?? null,
      locationLng: input.locationLng ?? null,
      visibility: input.visibility ?? "group",
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      status: statusForTime(input.startsAt ?? null),
    })
    .returning();

  return created;
}

export async function updateItemDetails(
  access: TripAccess,
  itemId: string,
  patch: Pick<
    CreateItemInput,
    "title" | "notes" | "category" | "locationName" | "locationLat" | "locationLng"
  >,
): Promise<Item> {
  const item = await getItem(access, itemId);
  if (!canEditItem(access, item))
    throw new RuleError("You can't edit this item once a planner has locked it.");

  const title = patch.title?.trim();
  if (patch.title !== undefined && !title) throw new RuleError("Give the item a title.");

  const [updated] = await db
    .update(items)
    .set({
      ...(title ? { title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
      ...(patch.category ? { category: patch.category } : {}),
      ...(patch.locationName !== undefined
        ? { locationName: patch.locationName?.trim() || null }
        : {}),
      ...(patch.locationLat !== undefined ? { locationLat: patch.locationLat } : {}),
      ...(patch.locationLng !== undefined ? { locationLng: patch.locationLng } : {}),
      ...touch,
    })
    .where(eq(items.id, itemId))
    .returning();

  // Lodging details only make sense for a lodging item -- if the category
  // just moved away from it, whatever was there is now orphaned.
  if (patch.category && patch.category !== "lodging") {
    await db.delete(lodgingDetails).where(eq(lodgingDetails.itemId, itemId));
  }

  return updated;
}

/** idea → proposed, or moves an existing proposal to a different time. */
export async function scheduleItem(
  access: TripAccess,
  itemId: string,
  startsAt: Date,
  endsAt: Date | null,
): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkPropose(item, actorFor(access, item), startsAt));
  if (endsAt && startsAt >= endsAt)
    throw new RuleError("The end time must come after the start time.");

  const [updated] = await db
    .update(items)
    .set({ startsAt, endsAt, status: "proposed", ...touch })
    .where(eq(items.id, itemId))
    .returning();

  return updated;
}

/** proposed → idea. Keeps the item and its discussion; drops the time. */
export async function unscheduleItem(access: TripAccess, itemId: string): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkUnschedule(item, actorFor(access, item)));

  const [updated] = await db
    .update(items)
    .set({ startsAt: null, endsAt: null, status: "idea", ...touch })
    .where(eq(items.id, itemId))
    .returning();

  return updated;
}

export async function lockItem(
  access: TripAccess,
  itemId: string,
  commitment: Commitment | null,
): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkLock(item, actorFor(access, item), commitment));

  const [updated] = await db
    .update(items)
    .set({
      status: "locked",
      commitment,
      lockedAt: new Date(),
      lockedBy: access.viewer.id,
      ...touch,
    })
    .where(eq(items.id, itemId))
    .returning();

  return updated;
}

export async function unlockItem(access: TripAccess, itemId: string): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkUnlock(item, actorFor(access, item)));

  // RSVPs are answers to a specific locked plan. If it goes back to being a
  // proposal, those answers no longer mean anything.
  await db.delete(itemRsvps).where(eq(itemRsvps.itemId, itemId));

  const [updated] = await db
    .update(items)
    .set({
      status: statusForTime(item.startsAt),
      commitment: null,
      lockedAt: null,
      lockedBy: null,
      ...touch,
    })
    .where(eq(items.id, itemId))
    .returning();

  return updated;
}

export async function declineItem(access: TripAccess, itemId: string): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkDecline(item, actorFor(access, item)));

  const [updated] = await db
    .update(items)
    .set({ status: "declined", ...touch })
    .where(eq(items.id, itemId))
    .returning();

  return updated;
}

export async function restoreItem(access: TripAccess, itemId: string): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkRestore(item, actorFor(access, item)));

  const [updated] = await db
    .update(items)
    .set({ status: statusForTime(item.startsAt), ...touch })
    .where(eq(items.id, itemId))
    .returning();

  return updated;
}

export async function setRsvp(
  access: TripAccess,
  itemId: string,
  response: "yes" | "no" | "maybe",
): Promise<void> {
  const item = await getItem(access, itemId);
  enforce(checkRsvp(item));

  await db
    .insert(itemRsvps)
    .values({ itemId, userId: access.viewer.id, response, respondedAt: new Date() })
    .onConflictDoUpdate({
      target: [itemRsvps.itemId, itemRsvps.userId],
      set: { response, respondedAt: new Date() },
    });
}

export async function deleteItem(access: TripAccess, itemId: string): Promise<void> {
  const item = await getItem(access, itemId);
  const actor = actorFor(access, item);
  if (item.status === "locked")
    throw new RuleError("Unlock the item before deleting it.");
  if (!actor.isAuthor && !access.isPlanner)
    throw new RuleError("Only the person who added this, or a planner, can delete it.");

  await db.delete(items).where(and(eq(items.id, itemId), eq(items.tripId, access.trip.id)));
}
