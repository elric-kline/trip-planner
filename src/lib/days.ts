import { and, asc, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db";
import { tripDays, tripDayWaypoints } from "@/db/schema";
import { eachCalendarDate } from "./time.ts";
import { RuleError } from "./items.ts";
import type { TripAccess } from "./scope.ts";

export type TripDay = typeof tripDays.$inferSelect;
export type TripDayWaypoint = typeof tripDayWaypoints.$inferSelect;

export type DayLocationInput = {
  wakeLocationName?: string | null;
  wakeLocationLat?: number | null;
  wakeLocationLng?: number | null;
  sleepLocationName?: string | null;
  sleepLocationLat?: number | null;
  sleepLocationLng?: number | null;
};

/**
 * One trip_days row per calendar date of the trip, called once right after
 * the trip itself is created (see trips.ts's createTrip) -- see schema.ts's
 * own comment on tripDays for why this is a fixed 1:1 seed rather than
 * something the planner builds up piecemeal.
 *
 * onConflictDoNothing rather than a plain insert: trip_days has a unique
 * (tripId, date) index, so this is safe to call more than once for the
 * same trip -- which ensureDaysSeeded below relies on to self-heal a trip
 * with no days without a distinct "insert vs. no-op" code path.
 */
export async function seedDays(tripId: string, startDate: string, endDate: string): Promise<void> {
  const dates = eachCalendarDate(startDate, endDate);
  await db
    .insert(tripDays)
    .values(dates.map((date) => ({ tripId, date })))
    .onConflictDoNothing();
}

/**
 * Backfills a trip that predates the Days feature (or otherwise ended up
 * with no trip_days rows -- a failed seedDays call, a trip inserted some
 * other way) by seeding them lazily the next time its days are viewed,
 * rather than requiring a one-off migration script run against production.
 * Idempotent and safe under concurrent requests: seedDays' own
 * onConflictDoNothing is what actually prevents duplicates, this
 * length-check is just the common case's fast path that skips the insert
 * entirely once a trip is already seeded.
 */
export async function ensureDaysSeeded(trip: { id: string; startDate: string; endDate: string }): Promise<void> {
  const [existing] = await db.select({ id: tripDays.id }).from(tripDays).where(eq(tripDays.tripId, trip.id)).limit(1);
  if (existing) return;
  await seedDays(trip.id, trip.startDate, trip.endDate);
}

/** Every day of the trip, in date order. Self-heals a trip with no days first (see ensureDaysSeeded) -- every other reader of trip_days goes through here or waypointsForDays, so this is the one place that needs to know about backfilling. */
export async function listDays(access: TripAccess): Promise<TripDay[]> {
  await ensureDaysSeeded(access.trip);
  return db
    .select()
    .from(tripDays)
    .where(eq(tripDays.tripId, access.trip.id))
    .orderBy(asc(tripDays.date));
}

/** Batched so rendering a full itinerary doesn't issue one waypoints query per day. */
export async function waypointsForDays(dayIds: string[]): Promise<Map<string, TripDayWaypoint[]>> {
  if (dayIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(tripDayWaypoints)
    .where(inArray(tripDayWaypoints.dayId, dayIds))
    .orderBy(asc(tripDayWaypoints.position));

  const grouped = new Map<string, TripDayWaypoint[]>();
  for (const id of dayIds) grouped.set(id, []);
  for (const row of rows) grouped.get(row.dayId)?.push(row);
  return grouped;
}

/** Validated fetch: throws unless dayId is really one of this trip's own days. Also used by items.ts when placing an item into a day. */
export async function getDay(access: TripAccess, dayId: string): Promise<TripDay> {
  const [day] = await db.select().from(tripDays).where(eq(tripDays.id, dayId)).limit(1);
  if (!day || day.tripId !== access.trip.id) throw new RuleError("That day isn't part of this trip.");
  return day;
}

/**
 * The day, if any, whose calendar date matches. Used to auto-ground a
 * freshly-timed item (see items.ts's placeInDay) -- null, not a throw, when
 * the date falls outside the trip's own span, since that's a normal "can't
 * place it automatically" outcome, not a rule violation.
 */
export async function getDayByDate(tripId: string, date: string): Promise<TripDay | null> {
  const [day] = await db
    .select()
    .from(tripDays)
    .where(and(eq(tripDays.tripId, tripId), eq(tripDays.date, date)))
    .limit(1);
  return day ?? null;
}

/**
 * No lock/author concept exists for a day the way it does for an item --
 * this is shared trip structure, not any one person's proposal, so any
 * trip member may set it. (Unlike canEditItem, there's deliberately no
 * planner-only gate here.)
 */
export async function updateDayLocations(
  access: TripAccess,
  dayId: string,
  input: DayLocationInput,
): Promise<TripDay> {
  await getDay(access, dayId);

  const [updated] = await db
    .update(tripDays)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(tripDays.id, dayId))
    .returning();
  return updated;
}

export async function addWaypoint(
  access: TripAccess,
  dayId: string,
  input: { name: string; lat?: number | null; lng?: number | null },
): Promise<TripDayWaypoint> {
  await getDay(access, dayId);
  const name = input.name.trim();
  if (!name) throw new RuleError("Give the stop a name.");

  const [{ nextPosition }] = await db
    .select({ nextPosition: max(tripDayWaypoints.position) })
    .from(tripDayWaypoints)
    .where(eq(tripDayWaypoints.dayId, dayId));

  const [created] = await db
    .insert(tripDayWaypoints)
    .values({
      dayId,
      name,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      position: (nextPosition ?? -1) + 1,
    })
    .returning();
  return created;
}

async function getOwnWaypoint(access: TripAccess, waypointId: string): Promise<TripDayWaypoint> {
  const [waypoint] = await db
    .select()
    .from(tripDayWaypoints)
    .where(eq(tripDayWaypoints.id, waypointId))
    .limit(1);
  if (!waypoint) throw new RuleError("That stop doesn't exist.");
  await getDay(access, waypoint.dayId); // throws if the day isn't on this trip
  return waypoint;
}

export async function removeWaypoint(access: TripAccess, waypointId: string): Promise<void> {
  await getOwnWaypoint(access, waypointId);
  await db.delete(tripDayWaypoints).where(eq(tripDayWaypoints.id, waypointId));
}

/**
 * Swaps this waypoint's position with its immediate neighbor -- simple
 * adjacent-swap reordering rather than a full drag-and-drop UI, since the
 * only thing that matters is "which comes first," not arbitrary positions.
 */
export async function moveWaypoint(
  access: TripAccess,
  waypointId: string,
  direction: "up" | "down",
): Promise<void> {
  const waypoint = await getOwnWaypoint(access, waypointId);
  const siblings = await db
    .select()
    .from(tripDayWaypoints)
    .where(eq(tripDayWaypoints.dayId, waypoint.dayId))
    .orderBy(asc(tripDayWaypoints.position));

  const index = siblings.findIndex((s) => s.id === waypointId);
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  if (neighborIndex < 0 || neighborIndex >= siblings.length) return; // already at that end -- no-op

  const neighbor = siblings[neighborIndex];
  await db.update(tripDayWaypoints).set({ position: neighbor.position }).where(eq(tripDayWaypoints.id, waypoint.id));
  await db.update(tripDayWaypoints).set({ position: waypoint.position }).where(eq(tripDayWaypoints.id, neighbor.id));
}
