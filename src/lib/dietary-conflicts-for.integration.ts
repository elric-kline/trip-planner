import { test } from "node:test";
import assert from "node:assert/strict";
import { dietaryWarningsForItem, dietaryWarningsForViewer } from "./dietary-conflicts-for.ts";
import { createItem, lockItem, scheduleItem } from "./items.ts";
import { upsertDiningDetails } from "./dining.ts";
import { requireTripAccess } from "./scope.ts";
import { updateProfile } from "./profile.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

async function setupTrip() {
  const planner = await createTestUser();
  const veganMember = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, veganMember.id, "participant");
  await updateProfile(veganMember, { dietaryRestrictions: ["vegan", "gluten_free"] });
  const plannerAccess = await requireTripAccess(trip.id, planner);
  return { trip, userIds: [planner.id, veganMember.id], planner, veganMember, plannerAccess };
}

async function lockedDining(access: Awaited<ReturnType<typeof requireTripAccess>>) {
  const item = await createItem(access, { title: "Pizzeria", category: "dining" });
  const proposed = await scheduleItem(access, item.id, new Date("2026-10-01T19:00:00Z"), null);
  return lockItem(access, proposed.id, "required"); // required -> everyone attends
}

test("dietaryWarningsForViewer flags a required, locked dining item against every attendee's restrictions", async (t) => {
  const { trip, userIds, plannerAccess, veganMember } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await lockedDining(plannerAccess);
  await upsertDiningDetails(plannerAccess, item.id, { accommodates: ["vegetarian"] });

  const findings = await dietaryWarningsForViewer(plannerAccess);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].member.userId, veganMember.id);
  assert.deepEqual(findings[0].unmetTags.sort(), ["gluten_free", "vegan"]);
});

test("an unset (null/empty) accommodates means 'not analyzed' -- never a de-facto warning", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await lockedDining(plannerAccess);
  // No upsertDiningDetails call at all -- accommodates stays unset.
  assert.deepEqual(await dietaryWarningsForViewer(plannerAccess), []);

  await upsertDiningDetails(plannerAccess, item.id, { accommodates: [] });
  assert.deepEqual(await dietaryWarningsForViewer(plannerAccess), [], "an explicitly empty list is the same as unset");
});

test("a proposed (not yet locked) dining item is never flagged -- attendance isn't settled yet", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(plannerAccess, { title: "Not locked yet", category: "dining" });
  const proposed = await scheduleItem(plannerAccess, item.id, new Date("2026-10-02T19:00:00Z"), null);
  await upsertDiningDetails(plannerAccess, proposed.id, { accommodates: ["vegetarian"] });

  assert.deepEqual(await dietaryWarningsForViewer(plannerAccess), []);
});

test("dietaryWarningsForItem scopes to just one item, and returns [] for a non-dining or unanalyzed item", async (t) => {
  const { trip, userIds, plannerAccess, veganMember } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const activity = await lockItem(
    plannerAccess,
    (await scheduleItem(plannerAccess, (await createItem(plannerAccess, { title: "Hike" })).id, new Date("2026-10-03T09:00:00Z"), null)).id,
    "required",
  );
  assert.deepEqual(await dietaryWarningsForItem(plannerAccess, activity, ["vegetarian"]), []);

  const dining = await lockedDining(plannerAccess);
  assert.deepEqual(await dietaryWarningsForItem(plannerAccess, dining, null), []);

  const findings = await dietaryWarningsForItem(plannerAccess, dining, ["vegetarian"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].member.userId, veganMember.id);
});
