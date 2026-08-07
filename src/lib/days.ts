import { and, asc, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db";
import { tripDayLocationMembers, tripDayLocations, tripDays } from "@/db/schema";
import { eachCalendarDate } from "./time.ts";
import { RuleError } from "./items.ts";
import type { TripAccess } from "./scope.ts";

export type TripDay = typeof tripDays.$inferSelect;
export type TripDayLocation = typeof tripDayLocations.$inferSelect;
export type DayLocationKind = TripDayLocation["kind"];

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

/** Every day of the trip, in date order. Self-heals a trip with no days first (see ensureDaysSeeded) -- every other reader of trip_days goes through here, so this is the one place that needs to know about backfilling. */
export async function listDays(access: TripAccess): Promise<TripDay[]> {
  await ensureDaysSeeded(access.trip);
  return db
    .select()
    .from(tripDays)
    .where(eq(tripDays.tripId, access.trip.id))
    .orderBy(asc(tripDays.date));
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

/** Validated fetch: throws unless locationId is really a location on one of this trip's own days. */
async function getLocation(access: TripAccess, locationId: string): Promise<TripDayLocation> {
  const [location] = await db.select().from(tripDayLocations).where(eq(tripDayLocations.id, locationId)).limit(1);
  if (!location) throw new RuleError("That location doesn't exist.");
  await getDay(access, location.dayId); // throws if the day isn't on this trip
  return location;
}

/** Batched: every location (wake, sleep, and stops) for the given days, grouped by dayId. */
export async function locationsForDays(dayIds: string[]): Promise<Map<string, TripDayLocation[]>> {
  if (dayIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(tripDayLocations)
    .where(inArray(tripDayLocations.dayId, dayIds))
    .orderBy(asc(tripDayLocations.position));

  const grouped = new Map<string, TripDayLocation[]>();
  for (const id of dayIds) grouped.set(id, []);
  for (const row of rows) grouped.get(row.dayId)?.push(row);
  return grouped;
}

/** Batched: which member ids are included in each of the given locations. */
export async function locationMembersForLocations(locationIds: string[]): Promise<Map<string, string[]>> {
  if (locationIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(tripDayLocationMembers)
    .where(inArray(tripDayLocationMembers.locationId, locationIds));

  const grouped = new Map<string, string[]>();
  for (const id of locationIds) grouped.set(id, []);
  for (const row of rows) grouped.get(row.locationId)?.push(row.userId);
  return grouped;
}

/**
 * Every trip member is included by default the moment a location is
 * created -- see schema.ts's tripDayLocationMembers comment for why that's
 * explicit rows rather than "no rows means everyone."
 */
async function includeAllMembers(access: TripAccess, locationId: string): Promise<void> {
  if (access.members.length === 0) return;
  await db.insert(tripDayLocationMembers).values(access.members.map((m) => ({ locationId, userId: m.userId })));
}

/**
 * Adds a location of the given kind to a day -- wake, sleep, and stop are
 * all just lists (see schema.ts's tripDayLocations comment); the only
 * difference is display order (wake first, stops in the middle by
 * position, sleep last), never cardinality. A day can have more than one
 * wake or sleep location at once on purpose -- a split departure (my
 * brother and mother leave from Bethlehem, PA; I leave from NYC) is two
 * *different* wake locations on the same day, each with its own Includes
 * subset, not one location shared by everyone.
 *
 * No lock/author gate: this is shared trip structure, not any one
 * person's proposal, so any trip member may add one.
 */
export async function addLocation(
  access: TripAccess,
  dayId: string,
  kind: DayLocationKind,
  input: { name: string; lat?: number | null; lng?: number | null },
): Promise<TripDayLocation> {
  await getDay(access, dayId);
  const name = input.name.trim();
  if (!name) throw new RuleError("Give the location a name.");

  const [{ nextPosition }] = await db
    .select({ nextPosition: max(tripDayLocations.position) })
    .from(tripDayLocations)
    .where(and(eq(tripDayLocations.dayId, dayId), eq(tripDayLocations.kind, kind)));

  const [created] = await db
    .insert(tripDayLocations)
    .values({
      dayId,
      kind,
      name,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      position: (nextPosition ?? -1) + 1,
    })
    .returning();
  await includeAllMembers(access, created.id);
  return created;
}

/**
 * Edits an existing location's name/coordinates in place -- e.g. splitting
 * a combined entry like "PA/NYC" into two by first renaming it down to
 * just "PA," then adding "NYC" as its own location alongside it. Doesn't
 * touch who's included -- that's setLocationMembers' job, called
 * separately (see the "Save" form in DayCard.tsx, which submits both
 * together).
 */
export async function renameLocation(
  access: TripAccess,
  locationId: string,
  input: { name: string; lat?: number | null; lng?: number | null },
): Promise<TripDayLocation> {
  await getLocation(access, locationId);
  const name = input.name.trim();
  if (!name) throw new RuleError("Give the location a name.");

  const [updated] = await db
    .update(tripDayLocations)
    .set({ name, lat: input.lat ?? null, lng: input.lng ?? null, updatedAt: new Date() })
    .where(eq(tripDayLocations.id, locationId))
    .returning();
  return updated;
}

export async function removeLocation(access: TripAccess, locationId: string): Promise<void> {
  await getLocation(access, locationId);
  await db.delete(tripDayLocations).where(eq(tripDayLocations.id, locationId));
}

/**
 * Swaps position with the adjacent location of the *same kind* -- simple
 * adjacent-swap reordering rather than a full drag-and-drop UI, since the
 * only thing that matters is "which comes first," not arbitrary positions.
 * A wake location only ever reorders among other wake locations, never
 * past a stop or a sleep location -- each kind keeps its own sequence.
 */
export async function moveLocation(access: TripAccess, locationId: string, direction: "up" | "down"): Promise<void> {
  const location = await getLocation(access, locationId);

  const siblings = await db
    .select()
    .from(tripDayLocations)
    .where(and(eq(tripDayLocations.dayId, location.dayId), eq(tripDayLocations.kind, location.kind)))
    .orderBy(asc(tripDayLocations.position));

  const index = siblings.findIndex((s) => s.id === locationId);
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  if (neighborIndex < 0 || neighborIndex >= siblings.length) return; // already at that end -- no-op

  const neighbor = siblings[neighborIndex];
  await db.update(tripDayLocations).set({ position: neighbor.position }).where(eq(tripDayLocations.id, location.id));
  await db.update(tripDayLocations).set({ position: location.position }).where(eq(tripDayLocations.id, neighbor.id));
}

/**
 * Replaces a location's included-member set wholesale -- what backs each
 * location's "Includes" checkboxes (see schema.ts's tripDayLocationMembers,
 * and the split-party Day 1 example there). Silently drops any id that
 * isn't actually a member of this trip rather than rejecting the whole
 * save -- a stale checkbox list (someone left the trip between page load
 * and submit) shouldn't block everyone else's update, same forgiving
 * posture as elsewhere a form's own choices are re-validated server-side.
 */
export async function setLocationMembers(access: TripAccess, locationId: string, userIds: string[]): Promise<void> {
  await getLocation(access, locationId);
  const validIds = new Set(access.members.map((m) => m.userId));
  const included = [...new Set(userIds)].filter((id) => validIds.has(id));

  await db.delete(tripDayLocationMembers).where(eq(tripDayLocationMembers.locationId, locationId));
  if (included.length > 0) {
    await db.insert(tripDayLocationMembers).values(included.map((userId) => ({ locationId, userId })));
  }
}

/** All of a trip's locations, grouped by (dayId, kind) -- the unit a "branch" is measured over. Internal: callers want either autoIncludeSoleLocations or unresolvedBranchesForMember below, not the raw grouping. */
async function locationGroupsByDayAndKind(tripId: string): Promise<Map<string, TripDayLocation[]>> {
  const days = await db.select({ id: tripDays.id }).from(tripDays).where(eq(tripDays.tripId, tripId));
  const dayIds = days.map((d) => d.id);
  if (dayIds.length === 0) return new Map();

  const rows = await db.select().from(tripDayLocations).where(inArray(tripDayLocations.dayId, dayIds));
  const grouped = new Map<string, TripDayLocation[]>();
  for (const row of rows) {
    const key = `${row.dayId}:${row.kind}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  return grouped;
}

/**
 * Onboards a newly-invited member into whatever the trip has already
 * planned, for the parts that aren't actually in question: any (day, kind)
 * group with zero or one location has nothing to choose between, so the
 * new member is simply added to it, same as if they'd been there when it
 * was created. Called once, right when they accept the invite (see
 * trips.ts's acceptInvite) -- groups with two or more locations are left
 * alone; see unresolvedBranchesForMember for those.
 */
export async function autoIncludeSoleLocations(tripId: string, userId: string): Promise<void> {
  const groups = await locationGroupsByDayAndKind(tripId);
  const soleLocationIds = [...groups.values()].filter((g) => g.length === 1).map((g) => g[0].id);
  if (soleLocationIds.length === 0) return;

  await db
    .insert(tripDayLocationMembers)
    .values(soleLocationIds.map((locationId) => ({ locationId, userId })))
    .onConflictDoNothing();
}

export type LocationBranch = {
  dayId: string;
  date: string;
  kind: DayLocationKind;
  locations: TripDayLocation[];
};

/**
 * The (day, kind) groups that genuinely need a decision from this member:
 * two or more locations already exist (a split day -- see schema.ts's
 * tripDayLocationMembers for the Bethlehem/NYC example) and they aren't in
 * any of them yet. This is what a "join the trip" mini-wizard walks
 * through -- see the /trip/[tripId]/join page. A group they're already in
 * (e.g. resolved on an earlier visit, or added manually via the pencil
 * editor) is left out; there's nothing left to ask.
 */
export async function unresolvedBranchesForMember(tripId: string, userId: string): Promise<LocationBranch[]> {
  const groups = await locationGroupsByDayAndKind(tripId);
  const branchGroups = [...groups.entries()].filter(([, locations]) => locations.length > 1);
  if (branchGroups.length === 0) return [];

  const allLocationIds = branchGroups.flatMap(([, locations]) => locations.map((l) => l.id));
  const membersByLocation = await locationMembersForLocations(allLocationIds);

  const dayIds = [...new Set(branchGroups.flatMap(([, locations]) => locations.map((l) => l.dayId)))];
  const days = await db.select().from(tripDays).where(inArray(tripDays.id, dayIds));
  const dateByDayId = new Map(days.map((d) => [d.id, d.date]));

  const branches: LocationBranch[] = [];
  for (const [, locations] of branchGroups) {
    const alreadyIn = locations.some((l) => (membersByLocation.get(l.id) ?? []).includes(userId));
    if (alreadyIn) continue;
    branches.push({
      dayId: locations[0].dayId,
      date: dateByDayId.get(locations[0].dayId) ?? "",
      kind: locations[0].kind,
      locations,
    });
  }
  return branches.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/** Adds the viewer to an existing location -- the "I'm with this one" choice in the join wizard. Additive: doesn't touch who else is already in it. */
export async function joinLocation(access: TripAccess, locationId: string): Promise<void> {
  await getLocation(access, locationId);
  await db
    .insert(tripDayLocationMembers)
    .values({ locationId, userId: access.viewer.id })
    .onConflictDoNothing();
}

/**
 * Starts a brand new branch for just the viewer -- the "neither, I'm doing
 * my own thing" choice in the join wizard. Reuses addLocation (which
 * defaults to including every current trip member, right for the normal
 * "a planner adds a location" case) and then immediately narrows it down
 * to the viewer alone, since a fresh branch started this way is what
 * defines *their* leg, not everyone's.
 */
export async function addLocationForSelf(
  access: TripAccess,
  dayId: string,
  kind: DayLocationKind,
  input: { name: string; lat?: number | null; lng?: number | null },
): Promise<TripDayLocation> {
  const created = await addLocation(access, dayId, kind, input);
  await setLocationMembers(access, created.id, [access.viewer.id]);
  return created;
}
