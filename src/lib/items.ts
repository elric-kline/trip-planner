import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  diningDetails,
  itemRsvps,
  items,
  lodgingDetails,
  transportDetails,
  transportLegs,
} from "@/db/schema";
import {
  checkDecline,
  checkLock,
  checkPropose,
  checkRestore,
  checkRsvp,
  checkShare,
  checkUnlock,
  checkUnschedule,
  statusForTime,
  type Actor,
  type Check,
  type Commitment,
} from "./lifecycle.ts";
import { canEditItem, getItem, type Item, type TripAccess } from "./scope.ts";
import { getDay, getDayByDate } from "./days.ts";
import { calendarDateInZone } from "./time.ts";
import { itemsConflict } from "./conflicts.ts";

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
  /** Explicit day placement, from the day-scoped "+ Add" UI. Omitted for the trip-wide "Add something" form, which creates an ungrounded idea. */
  dayId?: string | null;
  /** Manual insertion point within dayId's draft order — omitted appends to the end. Ignored once startsAt is given; see placeInDay. */
  afterItemId?: string;
};

/**
 * Where a day-linked (or about-to-be) item sits: which day, and its
 * dayPosition within that day's draft order.
 *
 * A startsAt, once known, is always the authority on order — manual
 * placement (dayId/afterItemId) only decides where an untimed item lands.
 * That's what lets "+ Add" between two items build a rough draft before
 * anyone commits to exact times, while a proposal that does get a time
 * still settles into its correct chronological spot automatically. See
 * chronoPositionInDay and computeDayPosition below for the two halves of
 * that split.
 */
async function placeInDay(
  access: TripAccess,
  opts: {
    existingDayId?: string | null;
    requestedDayId?: string | null;
    afterItemId?: string;
    startsAt?: Date | null;
    excludeItemId?: string;
  },
): Promise<{ dayId: string | null; dayPosition: number | null }> {
  let dayId = opts.existingDayId ?? opts.requestedDayId ?? null;
  if (dayId) await getDay(access, dayId); // throws if it isn't really one of this trip's own days

  // No day chosen yet -- ground it automatically if its time lands on one
  // of the trip's own dates. An item that's neither given a day nor a time
  // stays a fully ungrounded idea.
  if (!dayId && opts.startsAt) {
    const day = await getDayByDate(access.trip.id, calendarDateInZone(opts.startsAt, access.trip.timezone));
    dayId = day?.id ?? null;
  }
  if (!dayId) return { dayId: null, dayPosition: null };

  if (opts.startsAt) {
    const resnapped = await chronoPositionInDay(dayId, opts.startsAt, opts.excludeItemId);
    if (resnapped !== null) return { dayId, dayPosition: resnapped };
  }
  return { dayId, dayPosition: await computeDayPosition(dayId, opts.afterItemId) };
}

/**
 * Appends to the end of dayId's draft, or -- if afterItemId is given --
 * slots in immediately after that item. Fractional-index midpoint
 * insertion (same idea as tripDayWaypoints.position, but shifting no other
 * row on an insert-between, at the cost of needing an occasional
 * renormalization pass this app doesn't yet have -- not a concern at the
 * scale of one trip's worth of manual inserts).
 */
async function computeDayPosition(dayId: string, afterItemId?: string): Promise<number> {
  const siblings = await db
    .select({ id: items.id, dayPosition: items.dayPosition })
    .from(items)
    .where(eq(items.dayId, dayId))
    .orderBy(asc(items.dayPosition));

  // The empty-day shortcut only applies to a plain append -- an
  // afterItemId naming an item that isn't there (including "there are no
  // items at all yet") is always a mistake to report, not something to
  // silently normalize into position 0.
  if (afterItemId === undefined) {
    return siblings.length === 0 ? 0 : (siblings[siblings.length - 1].dayPosition ?? 0) + 1;
  }

  const idx = siblings.findIndex((s) => s.id === afterItemId);
  if (idx === -1) throw new RuleError("Can't insert after an item that isn't in this day.");
  const after = siblings[idx].dayPosition ?? 0;
  // dayPosition is nullable in the column type but always set in practice
  // for a day-linked row; `?? undefined` just collapses that theoretical
  // null into the same "nothing to bound against" case as no next sibling.
  const next = siblings[idx + 1]?.dayPosition ?? undefined;
  return next === undefined ? after + 1 : (after + next) / 2;
}

/**
 * Where startsAt would chronologically slot among dayId's other *timed*
 * items, as a dayPosition midpoint between its would-be neighbors — or
 * null if there's nothing timed yet to compare against, in which case the
 * caller falls back to manual placement (computeDayPosition). An untimed
 * sibling's own position is never used as a bound, only as filler that
 * ends up between whichever timed neighbors bracket it.
 */
async function chronoPositionInDay(
  dayId: string,
  startsAt: Date,
  excludeItemId?: string,
): Promise<number | null> {
  const filters = [eq(items.dayId, dayId)];
  if (excludeItemId) filters.push(ne(items.id, excludeItemId));

  const siblings = await db
    .select({ dayPosition: items.dayPosition, startsAt: items.startsAt })
    .from(items)
    .where(and(...filters))
    .orderBy(asc(items.dayPosition));

  const timed = siblings.filter(
    (s): s is { dayPosition: number; startsAt: Date } => s.startsAt != null && s.dayPosition != null,
  );
  if (timed.length === 0) return null;

  let before: { dayPosition: number; startsAt: Date } | undefined;
  let after: { dayPosition: number; startsAt: Date } | undefined;
  for (const s of timed) {
    if (s.startsAt <= startsAt) before = s;
    else {
      after = s;
      break;
    }
  }

  const lower = before?.dayPosition ?? (after ? after.dayPosition - 1 : 0);
  const upper = after?.dayPosition ?? (before ? before.dayPosition + 1 : 1);
  return (lower + upper) / 2;
}

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

  const { dayId, dayPosition } = await placeInDay(access, {
    requestedDayId: input.dayId,
    afterItemId: input.afterItemId,
    startsAt: input.startsAt,
  });

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
      dayId,
      dayPosition,
      status: statusForTime(input.startsAt ?? null),
    })
    .returning();

  return created;
}

export async function updateItemDetails(
  access: TripAccess,
  itemId: string,
  patch: Partial<
    Pick<CreateItemInput, "title" | "notes" | "category" | "locationName" | "locationLat" | "locationLng">
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

  // Category-specific details only make sense for their own category -- if
  // the category just moved away, whatever was there is now orphaned.
  if (patch.category && patch.category !== "lodging") {
    await db.delete(lodgingDetails).where(eq(lodgingDetails.itemId, itemId));
  }
  if (patch.category && patch.category !== "dining") {
    await db.delete(diningDetails).where(eq(diningDetails.itemId, itemId));
  }
  if (patch.category && patch.category !== "transport") {
    // Legs reference the item directly, not transportDetails -- both need
    // dropping, same as upsertTransportDetails does when only the subtype
    // (not the whole category) moves off "flight".
    await db.delete(transportLegs).where(eq(transportLegs.itemId, itemId));
    await db.delete(transportDetails).where(eq(transportDetails.itemId, itemId));
  }

  return updated;
}

/**
 * idea → proposed, or moves an existing proposal to a different time. An
 * item that wasn't already linked to a day (a pure idea) gets auto-grounded
 * here if the new time lands on one of the trip's own dates — see
 * placeInDay. An item already linked to a day stays on that day even if
 * the new time's date disagrees; the planner put it there on purpose.
 */
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

  let dayId = item.dayId;
  let dayPosition = item.dayPosition;

  if (!dayId) {
    // Not on a day yet -- ground it now if the new time falls on one of
    // the trip's own dates (see placeInDay).
    const placed = await placeInDay(access, { startsAt });
    dayId = placed.dayId;
    dayPosition = placed.dayPosition;
  } else {
    // Already on a day the planner chose -- a time still governs its order
    // among that day's other timed items; with nothing timed yet to
    // compare against, its manual position is left exactly where it was.
    const resnapped = await chronoPositionInDay(dayId, startsAt, itemId);
    if (resnapped !== null) dayPosition = resnapped;
  }

  const [updated] = await db
    .update(items)
    .set({ startsAt, endsAt, status: "proposed", dayId, dayPosition, ...touch })
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

/**
 * Locking something as *required* puts the whole group on that slot, so every
 * still-open proposal that genuinely clashes with it has lost -- nobody can
 * attend both. Their "I'm in" answers are answers to a question that's now
 * settled, so they're voided rather than left to imply support for something
 * unattendable.
 *
 * "Genuinely clashes" is itemsConflict, not raw windowsOverlap -- locking a
 * two-day lodging stay as required must not void every dinner reservation
 * and activity RSVP'd during it, since staying somewhere doesn't stop you
 * doing anything else while you're there. See conflicts.ts's itemsConflict
 * for the actual rule (lodging only displaces other lodging, or something
 * landing in its own arrival/departure buffer).
 *
 * Scoped to items that haven't been locked yet, on purpose. A locked *optional*
 * item that overlaps a newly-required one is a planner problem, not an RSVP
 * problem -- the lock preview and the trip page's conflict banner are what
 * surface that, and silently dropping people's answers to something already
 * agreed would hide it instead.
 *
 * Returns the ids it cleared so callers can say what happened.
 */
async function voidRsvpsDisplacedBy(locked: Item): Promise<string[]> {
  if (!locked.startsAt) return [];

  const rivals = await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.tripId, locked.tripId),
        eq(items.visibility, "group"),
        ne(items.id, locked.id),
        ne(items.status, "locked"),
        ne(items.status, "declined"),
        isNotNull(items.startsAt),
      ),
    );

  const displaced = rivals
    .filter((rival) =>
      itemsConflict(
        { startsAt: locked.startsAt!, endsAt: locked.endsAt, category: locked.category },
        { startsAt: rival.startsAt!, endsAt: rival.endsAt, category: rival.category },
      ),
    )
    .map((rival) => rival.id);

  if (displaced.length > 0) {
    await db.delete(itemRsvps).where(inArray(itemRsvps.itemId, displaced));
  }
  return displaced;
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

  if (commitment === "required") {
    await voidRsvpsDisplacedBy(updated);
  }

  return updated;
}

export async function unlockItem(access: TripAccess, itemId: string): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkUnlock(item, actorFor(access, item)));

  // RSVPs deliberately survive an unlock. They used to be wiped here, on the
  // reasoning that an answer to a locked plan means nothing once it's a
  // proposal again -- but an "I'm in" is now one answer about one item, valid
  // on either side of a lock (see lifecycle.ts's checkRsvp). Unlocking is
  // exactly the moment a planner most needs to know who wanted the thing.

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

/** Moves a Scratchpad item into PlaySpace -- see lifecycle.ts's checkShare for why this is author-only and blocked while locked. */
export async function shareItem(access: TripAccess, itemId: string): Promise<Item> {
  const item = await getItem(access, itemId);
  enforce(checkShare(item, actorFor(access, item)));

  const [updated] = await db
    .update(items)
    .set({ visibility: "group", ...touch })
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
