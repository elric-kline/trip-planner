import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tripDays } from "@/db/schema";
import {
  addWaypoint,
  ensureDaysSeeded,
  listDays,
  moveWaypoint,
  removeWaypoint,
  updateDayLocations,
  waypointsForDays,
} from "./days.ts";
import { RuleError } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

test("createTrip seeds one day per calendar date, inclusive, in date order", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-04" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));

  const access = await requireTripAccess(trip.id, owner);
  const days = await listDays(access);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
  );
  for (const day of days) {
    assert.equal(day.wakeLocationName, null);
    assert.equal(day.sleepLocationName, null);
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

test("updateDayLocations: any trip member may set wake/sleep locations, not just the planner", async (t) => {
  const owner = await createTestUser();
  const participant = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-02" });
  await addTripMember(trip.id, participant.id, "participant");
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const ownerAccess = await requireTripAccess(trip.id, owner);
  const participantAccess = await requireTripAccess(trip.id, participant);
  const [firstDay] = await listDays(ownerAccess);

  const updated = await updateDayLocations(participantAccess, firstDay.id, {
    wakeLocationName: "Seattle, WA",
    wakeLocationLat: 47.6062,
    wakeLocationLng: -122.3321,
    sleepLocationName: "Victoria, BC",
    sleepLocationLat: 48.4284,
    sleepLocationLng: -123.3656,
  });

  assert.equal(updated.wakeLocationName, "Seattle, WA");
  assert.equal(updated.sleepLocationName, "Victoria, BC");
});

test("updateDayLocations rejects a day id from a different trip", async (t) => {
  const owner = await createTestUser();
  const tripA = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const tripB = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  t.after(() => cleanupTrip(tripA.id, []).then(() => cleanupTrip(tripB.id, [owner.id])));

  const accessA = await requireTripAccess(tripA.id, owner);
  const accessB = await requireTripAccess(tripB.id, owner);
  const [dayOfTripB] = await listDays(accessB);

  await assert.rejects(
    () => updateDayLocations(accessA, dayOfTripB.id, { wakeLocationName: "Wrong trip" }),
    RuleError,
  );
});

test("updateDayLocations rejects an unknown day id", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));
  const access = await requireTripAccess(trip.id, owner);

  await assert.rejects(() => updateDayLocations(access, randomUUID(), { wakeLocationName: "x" }), RuleError);
});

test("addWaypoint: rejects a blank name, otherwise appends in order and is retrievable via waypointsForDays", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));
  const access = await requireTripAccess(trip.id, owner);
  const [day] = await listDays(access);

  await assert.rejects(() => addWaypoint(access, day.id, { name: "   " }), RuleError);

  const first = await addWaypoint(access, day.id, { name: "Lunch in Ennis", lat: 52.84, lng: -8.98 });
  const second = await addWaypoint(access, day.id, { name: "Dinner in Galway" });
  assert.equal(first.position, 0);
  assert.equal(second.position, 1);

  assert.deepEqual(await waypointsForDays([]), new Map());
  const map = await waypointsForDays([day.id]);
  assert.deepEqual(
    map.get(day.id)?.map((w) => w.name),
    ["Lunch in Ennis", "Dinner in Galway"],
  );
});

test("moveWaypoint swaps position with its neighbor; no-ops at either end", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));
  const access = await requireTripAccess(trip.id, owner);
  const [day] = await listDays(access);

  const a = await addWaypoint(access, day.id, { name: "A" });
  const b = await addWaypoint(access, day.id, { name: "B" });
  const c = await addWaypoint(access, day.id, { name: "C" });

  await moveWaypoint(access, b.id, "up"); // B, A, C
  let names = (await waypointsForDays([day.id])).get(day.id)?.map((w) => w.name);
  assert.deepEqual(names, ["B", "A", "C"]);

  await moveWaypoint(access, b.id, "up"); // already first -- no-op
  names = (await waypointsForDays([day.id])).get(day.id)?.map((w) => w.name);
  assert.deepEqual(names, ["B", "A", "C"]);

  await moveWaypoint(access, c.id, "down"); // already last -- no-op
  names = (await waypointsForDays([day.id])).get(day.id)?.map((w) => w.name);
  assert.deepEqual(names, ["B", "A", "C"]);

  void a; // referenced only to name the initial ordering clearly
});

test("removeWaypoint deletes it; rejects a waypoint belonging to another trip's day", async (t) => {
  const owner = await createTestUser();
  const tripA = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const tripB = await createTestTrip(owner, { startDate: "2026-10-01", endDate: "2026-10-01" });
  t.after(() => cleanupTrip(tripA.id, []).then(() => cleanupTrip(tripB.id, [owner.id])));

  const accessA = await requireTripAccess(tripA.id, owner);
  const accessB = await requireTripAccess(tripB.id, owner);
  const [dayA] = await listDays(accessA);
  const [dayB] = await listDays(accessB);

  const waypointOnB = await addWaypoint(accessB, dayB.id, { name: "Belongs to trip B" });
  await assert.rejects(() => removeWaypoint(accessA, waypointOnB.id), RuleError);

  const waypointOnA = await addWaypoint(accessA, dayA.id, { name: "Belongs to trip A" });
  await removeWaypoint(accessA, waypointOnA.id);
  assert.deepEqual((await waypointsForDays([dayA.id])).get(dayA.id), []);
});

test("removeWaypoint rejects an unknown waypoint id", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id]));
  const access = await requireTripAccess(trip.id, owner);

  await assert.rejects(() => removeWaypoint(access, randomUUID()), RuleError);
});
