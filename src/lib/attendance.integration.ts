import { test } from "node:test";
import assert from "node:assert/strict";
import { attendanceFor, attendingItems, myRsvp, rsvpsForItems } from "./attendance.ts";
import { createItem, declineItem, lockItem, restoreItem, scheduleItem, setRsvp } from "./items.ts";
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

test("a proposal reports its support, so a planner can see it before locking", async (t) => {
  const { trip, userIds, memberA, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));
  const memberAAccess = await requireTripAccess(trip.id, memberA);

  const proposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Dinner idea" })).id,
    new Date("2026-07-01T18:00:00Z"),
    null,
  );

  const before = await attendanceFor(plannerAccess, proposed);
  assert.deepEqual(before.attendees, [], "nobody has answered yet");
  assert.equal(before.awaiting.length, 3, "all three members are awaiting, not invisible");

  await setRsvp(memberAAccess, proposed.id, "yes");

  const after = await attendanceFor(plannerAccess, proposed);
  assert.deepEqual(
    after.attendees.map((m) => m.userId),
    [memberA.id],
    "support on a proposal is visible without locking it first",
  );
});

test("a declined item reports nobody, even though its answers are kept", async (t) => {
  const { trip, userIds, memberA, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));
  const memberAAccess = await requireTripAccess(trip.id, memberA);

  const proposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Rained-off picnic" })).id,
    new Date("2026-07-02T12:00:00Z"),
    null,
  );
  await setRsvp(memberAAccess, proposed.id, "yes");
  const declined = await declineItem(plannerAccess, proposed.id);

  const attendance = await attendanceFor(plannerAccess, declined);
  assert.deepEqual(attendance, { attendees: [], awaiting: [], declined: [], automatic: false });

  const restored = await restoreItem(plannerAccess, declined.id);
  const back = await attendanceFor(plannerAccess, restored);
  assert.deepEqual(
    back.attendees.map((m) => m.userId),
    [memberA.id],
    "restoring brings the support back with it",
  );
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

test("attendingItems: required items always pass; optional items only pass for a yes RSVP -- a no or no-answer both drop out", async (t) => {
  const { trip, userIds, memberA, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const required = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "Required" })).id, new Date("2026-07-05T09:00:00Z"), null)).id,
    "required",
  );
  const optionalYes = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "Optional, said yes" })).id, new Date("2026-07-05T10:00:00Z"), null)).id,
    "optional",
  );
  const optionalNo = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "Optional, said no" })).id, new Date("2026-07-05T11:00:00Z"), null)).id,
    "optional",
  );
  const optionalUnanswered = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "Optional, no answer" })).id, new Date("2026-07-05T12:00:00Z"), null)).id,
    "optional",
  );

  const memberAAccess = await requireTripAccess(trip.id, memberA);
  await setRsvp(memberAAccess, optionalYes.id, "yes");
  await setRsvp(memberAAccess, optionalNo.id, "no");

  const all = [required, optionalYes, optionalNo, optionalUnanswered];
  const rsvps = await rsvpsForItems(all.map((i) => i.id));
  const rsvpMap = new Map(rsvps.map((r) => [r.itemId, r.responses]));

  const mine = attendingItems(all, rsvpMap, memberA.id);
  assert.deepEqual(mine.map((i) => i.id).sort(), [required.id, optionalYes.id].sort());
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
