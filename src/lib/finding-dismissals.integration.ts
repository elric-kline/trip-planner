import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissFinding, dismissedFindingKeysForViewer, undismissFinding } from "./finding-dismissals.ts";
import { timelineFindingsForViewer } from "./conflicts-for.ts";
import { findingKey, findingRef } from "./conflicts.ts";
import { createItem, lockItem, scheduleItem, unlockItem } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

async function setupTrip() {
  const planner = await createTestUser();
  const memberA = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, memberA.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  const memberAAccess = await requireTripAccess(trip.id, memberA);
  return { trip, userIds: [planner.id, memberA.id], plannerAccess, memberAAccess };
}

/** Same coordinates for every item here -- "the same property," so travel time is ~0 and any gap is measured purely against the tight threshold's own floor. */
const PROPERTY = { lat: 40.0, lng: -74.0 };

async function lockedRequired(access: Awaited<ReturnType<typeof requireTripAccess>>, title: string, startsAt: Date) {
  const created = await createItem(access, { title, locationLat: PROPERTY.lat, locationLng: PROPERTY.lng });
  const proposed = await scheduleItem(access, created.id, startsAt, null);
  return lockItem(access, proposed.id, "required");
}

/** A tight-but-not-overlapping pair: a garden tour ending right as dinner starts on the same property, close enough to read as tight even with ~0 travel time between them. */
async function tightPair(access: Awaited<ReturnType<typeof requireTripAccess>>) {
  await lockedRequired(access, "Garden tour", new Date("2026-09-01T17:00:00Z")); // 17:00-18:00 (default duration)
  await lockedRequired(access, "Dinner", new Date("2026-09-01T18:05:00Z"));
}

test("dismissFinding removes a finding from timelineFindingsForViewer's active list and moves it to dismissed", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await tightPair(plannerAccess);

  const before = await timelineFindingsForViewer(plannerAccess);
  assert.equal(before.active.length, 1);
  assert.equal(before.dismissed.length, 0);

  await dismissFinding(plannerAccess, findingRef(before.active[0]));

  const after = await timelineFindingsForViewer(plannerAccess);
  assert.equal(after.active.length, 0, "a dismissed finding no longer shows as active");
  assert.equal(after.dismissed.length, 1);
  assert.equal(findingKey(findingRef(after.dismissed[0])), findingKey(findingRef(before.active[0])));
});

test("dismissFinding is per-viewer -- another member still sees the same finding as active", async (t) => {
  const { trip, userIds, plannerAccess, memberAAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await tightPair(plannerAccess);
  const [finding] = (await timelineFindingsForViewer(plannerAccess)).active;
  await dismissFinding(plannerAccess, findingRef(finding));

  const memberView = await timelineFindingsForViewer(memberAAccess);
  assert.equal(memberView.active.length, 1, "memberA never dismissed this, so it's still active for them");
});

test("dismissFinding is idempotent -- dismissing twice doesn't error", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await tightPair(plannerAccess);
  const [finding] = (await timelineFindingsForViewer(plannerAccess)).active;
  const ref = findingRef(finding);

  await dismissFinding(plannerAccess, ref);
  await dismissFinding(plannerAccess, ref);

  const keys = await dismissedFindingKeysForViewer(plannerAccess);
  assert.equal(keys.size, 1);
});

test("undismissFinding brings a dismissed finding back to active", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await tightPair(plannerAccess);
  const [finding] = (await timelineFindingsForViewer(plannerAccess)).active;
  const ref = findingRef(finding);

  await dismissFinding(plannerAccess, ref);
  assert.equal((await timelineFindingsForViewer(plannerAccess)).active.length, 0);

  await undismissFinding(plannerAccess, ref);
  const restored = await timelineFindingsForViewer(plannerAccess);
  assert.equal(restored.active.length, 1);
  assert.equal(restored.dismissed.length, 0);
});

test("a dismissal keyed on \"tight\" doesn't hide the same pair once it escalates to a real \"conflict\"", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const tour = await lockedRequired(plannerAccess, "Garden tour", new Date("2026-09-01T17:00:00Z"));
  await lockedRequired(plannerAccess, "Dinner", new Date("2026-09-01T18:05:00Z"));

  const [tight] = (await timelineFindingsForViewer(plannerAccess)).active;
  assert.equal(tight.severity, "tight");
  await dismissFinding(plannerAccess, findingRef(tight));
  assert.equal((await timelineFindingsForViewer(plannerAccess)).active.length, 0);

  // The tour runs long, so it now overlaps dinner outright -- a materially
  // worse finding that the "tight" dismissal must not silently swallow.
  await unlockItem(plannerAccess, tour.id);
  const rescheduled = await scheduleItem(
    plannerAccess,
    tour.id,
    new Date("2026-09-01T17:00:00Z"),
    new Date("2026-09-01T18:30:00Z"),
  );
  await lockItem(plannerAccess, rescheduled.id, "required");

  const after = await timelineFindingsForViewer(plannerAccess);
  assert.equal(after.active.length, 1, "the escalated conflict surfaces even though the earlier tight gap was dismissed");
  assert.equal(after.active[0].severity, "conflict");
});
