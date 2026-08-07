import { test } from "node:test";
import assert from "node:assert/strict";
import { getDiningDetails, getDiningDetailsForItems, upsertDiningDetails } from "./dining.ts";
import { RuleError, createItem, lockItem, scheduleItem } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

test("getDiningDetails is null until saved; upsertDiningDetails normalizes an empty accommodates to null", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "Sushi Saito", category: "dining" });
  assert.equal(await getDiningDetails(item.id), null);

  await upsertDiningDetails(access, item.id, { cuisine: "Sushi", accommodates: [] });
  const details = await getDiningDetails(item.id);
  assert.equal(details?.cuisine, "Sushi");
  assert.equal(details?.accommodates, null, "an empty array means 'not analyzed,' same as never having been set");

  await upsertDiningDetails(access, item.id, { accommodates: ["pescatarian"] });
  assert.deepEqual((await getDiningDetails(item.id))?.accommodates, ["pescatarian"]);
});

test("upsertDiningDetails validates category, reservedBy membership, and partySize", async (t) => {
  const planner = await createTestUser();
  const outsider = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id, outsider.id]));
  const access = await requireTripAccess(trip.id, planner);

  const activity = await createItem(access, { title: "Hike", category: "activity" });
  await assert.rejects(() => upsertDiningDetails(access, activity.id, { cuisine: "x" }), RuleError);

  const dining = await createItem(access, { title: "Trattoria", category: "dining" });
  await assert.rejects(
    () => upsertDiningDetails(access, dining.id, { reservedBy: outsider.id }),
    RuleError,
  );
  await assert.rejects(() => upsertDiningDetails(access, dining.id, { partySize: 0 }), RuleError);
  await assert.rejects(() => upsertDiningDetails(access, dining.id, { partySize: 2.5 }), RuleError);

  await upsertDiningDetails(access, dining.id, { partySize: 4 });
  assert.equal((await getDiningDetails(dining.id))?.partySize, 4);
});

test("upsertDiningDetails follows canEditItem: locked items are planner-only, even post-lock", async (t) => {
  const planner = await createTestUser();
  const author = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, author.id, "participant");
  t.after(() => cleanupTrip(trip.id, [planner.id, author.id]));

  const authorAccess = await requireTripAccess(trip.id, author);
  const plannerAccess = await requireTripAccess(trip.id, planner);

  const item = await createItem(authorAccess, { title: "Noma", category: "dining" });
  const proposed = await scheduleItem(authorAccess, item.id, new Date("2026-08-02T19:00:00Z"), null);
  const locked = await lockItem(plannerAccess, proposed.id, "optional");

  await assert.rejects(
    () => upsertDiningDetails(authorAccess, locked.id, { cuisine: "Author tries after lock" }),
    RuleError,
  );
  await upsertDiningDetails(plannerAccess, locked.id, { confirmationNumber: "XYZ" });
  assert.equal((await getDiningDetails(locked.id))?.confirmationNumber, "XYZ");
});

test("getDiningDetailsForItems batches, and an empty id list short-circuits without a query", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  assert.deepEqual(await getDiningDetailsForItems([]), new Map());

  const item1 = await createItem(access, { title: "Place A", category: "dining" });
  const item2 = await createItem(access, { title: "Place B", category: "dining" });
  await upsertDiningDetails(access, item1.id, { cuisine: "Ramen" });

  const map = await getDiningDetailsForItems([item1.id, item2.id]);
  assert.equal(map.get(item1.id)?.cuisine, "Ramen");
  assert.equal(map.has(item2.id), false, "an item with nothing saved just isn't in the map");
});
