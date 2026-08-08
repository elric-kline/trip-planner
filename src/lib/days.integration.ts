import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tripDays, users } from "@/db/schema";
import {
  addLocation,
  addLocationForSelf,
  autoIncludeSoleLocations,
  ensureDaysSeeded,
  joinLocation,
  listDays,
  locationMembersForLocations,
  locationsForDays,
  moveLocation,
  removeLocation,
  renameLocation,
  setLocationMembers,
  unresolvedBranchesForMember,
} from "./days.ts";
import { RuleError } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

test("createTrip seeds one day per calendar date, inclusive, in date order, with no locations yet", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-04" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));

  const access = await requireTripAccess(trip.id, owner);
  const days = await listDays(access);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
  );

  const locationsByDay = await locationsForDays(days.map((d) => d.id));
  for (const day of days) {
    assert.deepEqual(locationsByDay.get(day.id), []);
  }
});

test("listDays self-heals a trip with no trip_days rows, same as one that predates the Days feature would have", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-05", endDate: "2026-09-08" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));

  // Simulate a trip whose days were never seeded in the first place --
  // exactly the state a pre-Days-feature trip is in.
  await db.delete(tripDays).where(eq(tripDays.tripId, trip.id));
  const access = await requireTripAccess(trip.id, owner);
  const before = await db.select().from(tripDays).where(eq(tripDays.tripId, trip.id));
  assert.equal(before.length, 0, "sanity check: really has no days before listDays runs");

  const days = await listDays(access);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"],
  );
});

test("ensureDaysSeeded / listDays is idempotent -- repeated calls never duplicate a trip's day rows", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-03" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));
  const access = await requireTripAccess(trip.id, owner);

  await listDays(access);
  await listDays(access);
  await ensureDaysSeeded(access.trip);

  const rows = await db.select().from(tripDays).where(eq(tripDays.tripId, trip.id));
  assert.equal(rows.length, 3, "still exactly one row per calendar date, no duplicates");
});

test("a single-day trip still gets exactly one day", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));

  const access = await requireTripAccess(trip.id, owner);
  const days = await listDays(access);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, "2026-09-01");
});

async function setupTripWithDay(
  dates: { startDate: string; endDate: string } = { startDate: "2026-09-01", endDate: "2026-09-02" },
) {
  const owner = await createTestUser();
  const participant = await createTestUser();
  const trip = await createTestTrip(owner, dates);
  await addTripMember(trip.id, participant.id, "participant");
  const ownerAccess = await requireTripAccess(trip.id, owner);
  const participantAccess = await requireTripAccess(trip.id, participant);
  const [day] = await listDays(ownerAccess);
  return { trip, owner, participant, ownerAccess, participantAccess, day };
}

test("addLocation: any trip member may add one, not just the planner, and every current member is included by default", async (t) => {
  const { trip, owner, participant, participantAccess, day } = await setupTripWithDay();
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const wake = await addLocation(participantAccess, day.id, "wake", {
    name: "Seattle, WA",
    lat: 47.6062,
    lng: -122.3321,
  });
  const sleep = await addLocation(participantAccess, day.id, "sleep", { name: "Victoria, BC" });

  assert.equal(wake.name, "Seattle, WA");
  assert.equal(wake.lat, 47.6062);
  assert.equal(sleep.name, "Victoria, BC");

  const members = await locationMembersForLocations([wake.id, sleep.id]);
  assert.deepEqual(new Set(members.get(wake.id)), new Set([owner.id, participant.id]));
  assert.deepEqual(new Set(members.get(sleep.id)), new Set([owner.id, participant.id]));
});

test("addLocation rejects a blank name, for any kind", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay();
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  await assert.rejects(() => addLocation(ownerAccess, day.id, "wake", { name: "   " }), RuleError);
  await assert.rejects(() => addLocation(ownerAccess, day.id, "sleep", { name: "" }), RuleError);
  await assert.rejects(() => addLocation(ownerAccess, day.id, "stop", { name: "   " }), RuleError);
});

test("a day can have more than one wake (or sleep) location at once -- a split departure, each with its own Includes subset", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay();
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  // "My brother and mother depart from Bethlehem, PA; I depart from NYC" --
  // two different wake locations, same day, disjoint membership.
  const bethlehem = await addLocation(ownerAccess, day.id, "wake", { name: "Bethlehem, PA" });
  const nyc = await addLocation(ownerAccess, day.id, "wake", { name: "New York, NY" });
  await setLocationMembers(ownerAccess, bethlehem.id, [participant.id]);
  await setLocationMembers(ownerAccess, nyc.id, [owner.id]);

  const locations = (await locationsForDays([day.id])).get(day.id) ?? [];
  const wakes = locations.filter((l) => l.kind === "wake");
  assert.equal(wakes.length, 2, "both wake locations coexist");

  const members = await locationMembersForLocations([bethlehem.id, nyc.id]);
  assert.deepEqual(members.get(bethlehem.id), [participant.id]);
  assert.deepEqual(members.get(nyc.id), [owner.id]);
});

test("addLocation appends stops in order, independent of wake/sleep ordering", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  await addLocation(ownerAccess, day.id, "wake", { name: "Seattle, WA" }); // shouldn't affect stop ordering

  const first = await addLocation(ownerAccess, day.id, "stop", { name: "Lunch in Ennis", lat: 52.84, lng: -8.98 });
  const second = await addLocation(ownerAccess, day.id, "stop", { name: "Dinner in Galway" });
  assert.equal(first.position, 0);
  assert.equal(second.position, 1);

  const locations = (await locationsForDays([day.id])).get(day.id) ?? [];
  assert.deepEqual(
    locations.filter((l) => l.kind === "stop").map((l) => l.name),
    ["Lunch in Ennis", "Dinner in Galway"],
  );
});

test("addLocation rejects a day id from a different trip, and an unknown day id", async (t) => {
  const owner = await createTestUser();
  const tripA = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const tripB = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  t.after(() => cleanupTrip(tripA.id, []).then(() => cleanupTrip(tripB.id, [owner.id])));

  const accessA = await requireTripAccess(tripA.id, owner);
  const accessB = await requireTripAccess(tripB.id, owner);
  const [dayOfTripB] = await listDays(accessB);

  await assert.rejects(() => addLocation(accessA, dayOfTripB.id, "wake", { name: "Wrong trip" }), RuleError);
  await assert.rejects(() => addLocation(accessA, randomUUID(), "wake", { name: "Made up day" }), RuleError);
});

test("renameLocation edits an existing location's name/coordinates in place, without touching who's included", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  // Splitting a combined "PA/NYC" entry down to just "PA," so "NYC" can
  // become its own location alongside it.
  const combined = await addLocation(ownerAccess, day.id, "wake", { name: "PA/NYC" });
  await setLocationMembers(ownerAccess, combined.id, [owner.id]);

  const renamed = await renameLocation(ownerAccess, combined.id, { name: "PA", lat: 40.65, lng: -75.38 });
  assert.equal(renamed.id, combined.id, "same row, edited in place");
  assert.equal(renamed.name, "PA");
  assert.equal(renamed.lat, 40.65);

  const members = await locationMembersForLocations([combined.id]);
  assert.deepEqual(members.get(combined.id), [owner.id], "membership untouched by the rename");

  const nyc = await addLocation(ownerAccess, day.id, "wake", { name: "NYC" });
  const locations = (await locationsForDays([day.id])).get(day.id) ?? [];
  assert.deepEqual(
    new Set(locations.filter((l) => l.kind === "wake").map((l) => l.name)),
    new Set(["PA", "NYC"]),
    "now two genuinely separate locations",
  );
  void nyc;
});

test("renameLocation rejects a blank name, and a location belonging to another trip", async (t) => {
  const owner = await createTestUser();
  const tripA = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const tripB = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  t.after(() => cleanupTrip(tripA.id, []).then(() => cleanupTrip(tripB.id, [owner.id])));

  const accessA = await requireTripAccess(tripA.id, owner);
  const accessB = await requireTripAccess(tripB.id, owner);
  const [dayA] = await listDays(accessA);
  const [dayB] = await listDays(accessB);

  const locationOnA = await addLocation(accessA, dayA.id, "wake", { name: "Original" });
  await assert.rejects(() => renameLocation(accessA, locationOnA.id, { name: "   " }), RuleError);

  const locationOnB = await addLocation(accessB, dayB.id, "wake", { name: "Belongs to trip B" });
  await assert.rejects(() => renameLocation(accessA, locationOnB.id, { name: "Hijacked" }), RuleError);
});

test("locationsForDays([]) returns an empty map without querying", async () => {
  assert.deepEqual(await locationsForDays([]), new Map());
});

test("moveLocation swaps position with its neighbor of the same kind only; no-ops at either end", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  await addLocation(ownerAccess, day.id, "wake", { name: "Seattle, WA" }); // a different kind -- shouldn't be reachable by moving a stop
  const a = await addLocation(ownerAccess, day.id, "stop", { name: "A" });
  const b = await addLocation(ownerAccess, day.id, "stop", { name: "B" });
  const c = await addLocation(ownerAccess, day.id, "stop", { name: "C" });

  async function stopNames() {
    return ((await locationsForDays([day.id])).get(day.id) ?? [])
      .filter((l) => l.kind === "stop")
      .map((l) => l.name);
  }

  await moveLocation(ownerAccess, b.id, "up"); // B, A, C
  assert.deepEqual(await stopNames(), ["B", "A", "C"]);

  await moveLocation(ownerAccess, b.id, "up"); // already first -- no-op
  assert.deepEqual(await stopNames(), ["B", "A", "C"]);

  await moveLocation(ownerAccess, c.id, "down"); // already last -- no-op
  assert.deepEqual(await stopNames(), ["B", "A", "C"]);

  void a;
});

test("moveLocation on the only location of its kind is a no-op in both directions", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay();
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const wake = await addLocation(ownerAccess, day.id, "wake", { name: "Seattle, WA" });
  await moveLocation(ownerAccess, wake.id, "up");
  await moveLocation(ownerAccess, wake.id, "down");

  const locations = (await locationsForDays([day.id])).get(day.id) ?? [];
  assert.equal(locations.length, 1);
  assert.equal(locations[0].name, "Seattle, WA");
});

test("removeLocation deletes it (any kind); rejects a location belonging to another trip's day, and an unknown id", async (t) => {
  const owner = await createTestUser();
  const tripA = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const tripB = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  t.after(() => cleanupTrip(tripA.id, []).then(() => cleanupTrip(tripB.id, [owner.id])));

  const accessA = await requireTripAccess(tripA.id, owner);
  const accessB = await requireTripAccess(tripB.id, owner);
  const [dayA] = await listDays(accessA);
  const [dayB] = await listDays(accessB);

  const stopOnB = await addLocation(accessB, dayB.id, "stop", { name: "Belongs to trip B" });
  await assert.rejects(() => removeLocation(accessA, stopOnB.id), RuleError);

  const wakeOnA = await addLocation(accessA, dayA.id, "wake", { name: "Belongs to trip A" });
  await removeLocation(accessA, wakeOnA.id);
  assert.deepEqual((await locationsForDays([dayA.id])).get(dayA.id), []);

  await assert.rejects(() => removeLocation(accessA, randomUUID()), RuleError);
});

test("setLocationMembers replaces the included set wholesale, and silently drops ids that aren't actually trip members", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay();
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const wake = await addLocation(ownerAccess, day.id, "wake", { name: "Seattle, WA" });
  // Starts as both members (default all-in).
  let members = await locationMembersForLocations([wake.id]);
  assert.deepEqual(new Set(members.get(wake.id)), new Set([owner.id, participant.id]));

  // Narrow to just the owner.
  const outsiderId = randomUUID();
  await setLocationMembers(ownerAccess, wake.id, [owner.id, outsiderId]);
  members = await locationMembersForLocations([wake.id]);
  assert.deepEqual(members.get(wake.id), [owner.id], "the non-member id was silently dropped");

  // Widen back to everyone.
  await setLocationMembers(ownerAccess, wake.id, [owner.id, participant.id]);
  members = await locationMembersForLocations([wake.id]);
  assert.deepEqual(new Set(members.get(wake.id)), new Set([owner.id, participant.id]));

  // Down to nobody is a valid (if unusual) state -- not an error.
  await setLocationMembers(ownerAccess, wake.id, []);
  members = await locationMembersForLocations([wake.id]);
  assert.deepEqual(members.get(wake.id), []);
});

test("setLocationMembers rejects a location id that doesn't belong to this trip", async (t) => {
  const owner = await createTestUser();
  const tripA = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const tripB = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  t.after(() => cleanupTrip(tripA.id, []).then(() => cleanupTrip(tripB.id, [owner.id])));

  const accessA = await requireTripAccess(tripA.id, owner);
  const accessB = await requireTripAccess(tripB.id, owner);
  const [dayB] = await listDays(accessB);
  const stopOnB = await addLocation(accessB, dayB.id, "stop", { name: "Belongs to trip B" });

  await assert.rejects(() => setLocationMembers(accessA, stopOnB.id, [owner.id]), RuleError);
});

test("locationMembersForLocations([]) returns an empty map without querying", async () => {
  assert.deepEqual(await locationMembersForLocations([]), new Map());
});

test("autoIncludeSoleLocations adds a member to every group with no real choice, and leaves branches (2+) alone", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const soleWake = await addLocation(ownerAccess, day.id, "wake", { name: "Seattle, WA" });
  const branchA = await addLocation(ownerAccess, day.id, "sleep", { name: "Victoria, BC" });
  const branchB = await addLocation(ownerAccess, day.id, "sleep", { name: "Vancouver, BC" });
  // Both branch locations start with only the owner (narrow them down, as
  // if the owner had already resolved their own leg).
  await setLocationMembers(ownerAccess, branchA.id, [owner.id]);
  await setLocationMembers(ownerAccess, branchB.id, [owner.id]);

  const newcomer = await createTestUser();
  t.after(() => db.delete(users).where(eq(users.id, newcomer.id)));
  await addTripMember(trip.id, newcomer.id, "participant");
  await autoIncludeSoleLocations(trip.id, newcomer.id);

  const members = await locationMembersForLocations([soleWake.id, branchA.id, branchB.id]);
  assert.ok(members.get(soleWake.id)?.includes(newcomer.id), "added to the sole wake location");
  assert.ok(!members.get(branchA.id)?.includes(newcomer.id), "NOT added to either branch");
  assert.ok(!members.get(branchB.id)?.includes(newcomer.id), "NOT added to either branch");

  // Idempotent -- calling it again doesn't error or duplicate.
  await autoIncludeSoleLocations(trip.id, newcomer.id);
  const membersAgain = await locationMembersForLocations([soleWake.id]);
  assert.deepEqual(membersAgain.get(soleWake.id)?.filter((id) => id === newcomer.id), [newcomer.id]);
});

test("unresolvedBranchesForMember only lists groups with 2+ locations the member isn't in any of", async (t) => {
  const { trip, owner, participant, ownerAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  await addLocation(ownerAccess, day.id, "wake", { name: "Only one wake -- not a branch" });
  const legA = await addLocation(ownerAccess, day.id, "sleep", { name: "Leg A" });
  const legB = await addLocation(ownerAccess, day.id, "sleep", { name: "Leg B" });
  await setLocationMembers(ownerAccess, legA.id, [owner.id]);
  await setLocationMembers(ownerAccess, legB.id, []);

  // Not part of either leg yet -- this is a real branch for them.
  const branches = await unresolvedBranchesForMember(trip.id, participant.id);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].kind, "sleep");
  assert.equal(branches[0].date, "2026-09-01");
  assert.deepEqual(new Set(branches[0].locations.map((l) => l.name)), new Set(["Leg A", "Leg B"]));

  // Once they're in ONE of the branch's locations, it's no longer unresolved for them.
  await setLocationMembers(ownerAccess, legA.id, [owner.id, participant.id]);
  const resolved = await unresolvedBranchesForMember(trip.id, participant.id);
  assert.deepEqual(resolved, []);
});

test("joinLocation adds the viewer without disturbing who else is already in it; rejects a location from another trip", async (t) => {
  const { trip, owner, participant, ownerAccess, participantAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });

  const legA = await addLocation(ownerAccess, day.id, "wake", { name: "Leg A" });
  await setLocationMembers(ownerAccess, legA.id, [owner.id]);

  await joinLocation(participantAccess, legA.id);
  const members = await locationMembersForLocations([legA.id]);
  assert.deepEqual(new Set(members.get(legA.id)), new Set([owner.id, participant.id]));

  const otherTrip = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  // otherTrip first -- it's also owned by `owner`, and trips.createdBy has
  // no cascade, so the owner can't be deleted while it still exists.
  t.after(() => cleanupTrip(otherTrip.id, []).then(() => cleanupTrip(trip.id, [owner.id, participant.id])));
  const otherAccess = await requireTripAccess(otherTrip.id, owner);
  const [otherDay] = await listDays(otherAccess);
  const locationOnOtherTrip = await addLocation(otherAccess, otherDay.id, "wake", { name: "Belongs to another trip" });

  await assert.rejects(() => joinLocation(participantAccess, locationOnOtherTrip.id), RuleError);
});

test("addLocationForSelf creates a location included for the viewer alone, not every trip member", async (t) => {
  const { trip, owner, participant, participantAccess, day } = await setupTripWithDay({
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const created = await addLocationForSelf(participantAccess, day.id, "wake", { name: "My own leg" });
  const members = await locationMembersForLocations([created.id]);
  assert.deepEqual(members.get(created.id), [participant.id], "only the person who started this branch is in it");
});
