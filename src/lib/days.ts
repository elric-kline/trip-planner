import { asc, eq, inArray, max } from "drizzle-orm";
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
 */
export async function seedDays(tripId: string, startDate: string, endDate: string): Promise<void> {
  const dates = eachCalendarDate(startDate, endDate);
  await db.insert(tripDays).values(dates.map((date) => ({ tripId, date })));
}

/** Every day of the trip, in date order. */
export async function listDays(access: TripAccess): Promise<TripDay[]> {
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

async function getOwnDay(access: TripAccess, dayId: string): Promise<TripDay> {
  const [day] = await db.select().from(tripDays).where(eq(tripDays.id, dayId)).limit(1);
  if (!day || day.tripId !== access.trip.id) throw new RuleError("That day isn't part of this trip.");
  return day;
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
  await getOwnDay(access, dayId);

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
  await getOwnDay(access, dayId);
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
  await getOwnDay(access, waypoint.dayId); // throws if the day isn't on this trip
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
