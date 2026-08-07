import { test } from "node:test";
import assert from "node:assert/strict";
import { getLodgingDetails, upsertLodgingDetails } from "./lodging.ts";
import { RuleError, createItem, lockItem, scheduleItem } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

test("getLodgingDetails is null until something is saved; upsertLodgingDetails then creates or replaces", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "Hotel Riviera", category: "lodging" });
  assert.equal(await getLodgingDetails(item.id), null);

  await upsertLodgingDetails(access, item.id, { address: "1 Beach Rd", contactPhone: "555-0100" });
  const first = await getLodgingDetails(item.id);
  assert.equal(first?.address, "1 Beach Rd");

  await upsertLodgingDetails(access, item.id, { address: "2 Beach Rd" });
  const second = await getLodgingDetails(item.id);
  assert.equal(second?.address, "2 Beach Rd");
  assert.equal(second?.contactPhone, "555-0100", "a field omitted from this call's input is left as-is -- onConflictDoUpdate only sets the columns it was given");
});

test("upsertLodgingDetails rejects a non-lodging item and a bookedBy who isn't on the trip", async (t) => {
  const planner = await createTestUser();
  const outsider = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id, outsider.id]));
  const access = await requireTripAccess(trip.id, planner);

  const activity = await createItem(access, { title: "Hike", category: "activity" });
  await assert.rejects(() => upsertLodgingDetails(access, activity.id, { address: "x" }), RuleError);

  const lodging = await createItem(access, { title: "Cabin", category: "lodging" });
  await assert.rejects(
    () => upsertLodgingDetails(access, lodging.id, { bookedBy: outsider.id }),
    RuleError,
  );
});

test("upsertLodgingDetails follows canEditItem: locked items are planner-only, even post-lock", async (t) => {
  const planner = await createTestUser();
  const author = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, author.id, "participant");
  t.after(() => cleanupTrip(trip.id, [planner.id, author.id]));

  const authorAccess = await requireTripAccess(trip.id, author);
  const plannerAccess = await requireTripAccess(trip.id, planner);

  const item = await createItem(authorAccess, { title: "Villa", category: "lodging" });
  await upsertLodgingDetails(authorAccess, item.id, { address: "Before locking" });

  const proposed = await scheduleItem(authorAccess, item.id, new Date("2026-08-01T15:00:00Z"), null);
  const locked = await lockItem(plannerAccess, proposed.id, "required");

  await assert.rejects(
    () => upsertLodgingDetails(authorAccess, locked.id, { address: "Author tries after lock" }),
    RuleError,
  );

  // Booking details are exactly what a planner may still correct post-lock.
  await upsertLodgingDetails(plannerAccess, locked.id, { confirmationNumber: "ABC123" });
  const details = await getLodgingDetails(locked.id);
  assert.equal(details?.confirmationNumber, "ABC123");
});
