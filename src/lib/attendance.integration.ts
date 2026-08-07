import { test } from "node:test";
import assert from "node:assert/strict";
import { attendanceFor, myRsvp, rsvpsForItems } from "./attendance.ts";
import { createItem, lockItem, scheduleItem, setRsvp } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

/** Integration coverage for how attendance is computed for each item shape. */

async function setupTrip() {
  const planner = await createTestUser();
  const memberA = await createTestUser();
  const memberB = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, memberA.id, "participant");
  await addTripMember(trip.id, memberB.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  return { trip, userIds: [planner.id, memberA.id, memberB.id], planner, memberA, memberB, plannerAccess };
}

test("a private item is attended by exactly its author, automatically, regardless of status", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const idea = await createItem(plannerAccess, { title: "Solo museum visit", visibility: "private" });
  const attendance = await attendanceFor(plannerAccess, idea);

  assert.equal(attendance.automatic, true);
  assert.deepEqual(attendance.attendees.map((m) => m.userId), [plannerAccess.viewer.id]);
  assert.deepEqual(attendance.awaiting, []);
  assert.deepEqual(attendance.declined, []);
});

test("an unlocked group item has no attendance yet", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Dinner idea" })).id,
    new Date("2026-07-01T18:00:00Z"),
    null,
  );
  const attendance = await attendanceFor(plannerAccess, proposed);
  assert.deepEqual(attendance, { attendees: [], awaiting: [], declined: [], automatic: false });
});

test("a locked required item puts every current member on automatically -- no RSVP needed", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Group dinner" })).id,
    new Date("2026-07-01T18:00:00Z"),
    null,
  );
  const locked = await lockItem(plannerAccess, proposed.id, "required");
  const attendance = await attendanceFor(plannerAccess, locked);

  assert.equal(attendance.automatic, true);
  assert.equal(attendance.attendees.length, 3);
});

test("a locked optional item buckets members by their RSVP; a 'maybe' isn't awaiting, attending, or declined", async (t) => {
  const { trip, userIds, memberA, memberB, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Optional side trip" })).id,
    new Date("2026-07-02T09:00:00Z"),
    null,
  );
  const locked = await lockItem(plannerAccess, proposed.id, "optional");

  const memberAAccess = await requireTripAccess(trip.id, memberA);
  const memberBAccess = await requireTripAccess(trip.id, memberB);
  await setRsvp(memberAAccess, locked.id, "yes");
  await setRsvp(memberBAccess, locked.id, "no");
  // The planner deliberately leaves no RSVP -- stays "awaiting".

  const attendance = await attendanceFor(plannerAccess, locked);
  assert.equal(attendance.automatic, false);
  assert.deepEqual(attendance.attendees.map((m) => m.userId), [memberA.id]);
  assert.deepEqual(attendance.declined.map((m) => m.userId), [memberB.id]);
  assert.deepEqual(attendance.awaiting.map((m) => m.userId), [plannerAccess.viewer.id]);
});

test("myRsvp returns the viewer's own response, or null if they haven't answered", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Optional brunch" })).id,
    new Date("2026-07-03T10:00:00Z"),
    null,
  );
  const locked = await lockItem(plannerAccess, proposed.id, "optional");

  assert.equal(await myRsvp(plannerAccess, locked.id), null);
  await setRsvp(plannerAccess, locked.id, "maybe");
  assert.equal(await myRsvp(plannerAccess, locked.id), "maybe");
});

test("rsvpsForItems: empty input short-circuits without a query; otherwise batches across multiple items", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  assert.deepEqual(await rsvpsForItems([]), []);

  const item1 = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "A" })).id, new Date("2026-07-04T10:00:00Z"), null)).id,
    "optional",
  );
  const item2 = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "B" })).id, new Date("2026-07-04T11:00:00Z"), null)).id,
    "optional",
  );
  await setRsvp(plannerAccess, item1.id, "yes");

  const results = await rsvpsForItems([item1.id, item2.id]);
  const byId = new Map(results.map((r) => [r.itemId, r.responses]));
  assert.equal(byId.get(item1.id)?.get(plannerAccess.viewer.id), "yes");
  assert.equal(byId.get(item2.id)?.size, 0, "an item with no RSVPs still has an entry, just empty");
});
