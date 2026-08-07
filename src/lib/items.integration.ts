import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { diningDetails, itemRsvps, lodgingDetails } from "@/db/schema";
import {
  createItem,
  deleteItem,
  declineItem,
  lockItem,
  restoreItem,
  RuleError,
  scheduleItem,
  setRsvp,
  unlockItem,
  unscheduleItem,
  updateItemDetails,
} from "./items.ts";
import { AccessError, getItem, requireTripAccess } from "./scope.ts";
import { upsertLodgingDetails } from "./lodging.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

/**
 * Integration coverage for the item lifecycle: creation validation, edit
 * permissions, the idea -> proposed -> locked -> declined state machine, and
 * the side effects that ride along with each transition (RSVPs wiped on
 * unlock, category-specific details orphaned on a category change). The
 * pure transition rules themselves are already unit-tested in
 * lifecycle.test.ts with no database -- this file checks that items.ts
 * actually enforces them and persists the results correctly, which is the
 * part a pure test can't see.
 */

async function setupTrip() {
  const planner = await createTestUser();
  const author = await createTestUser();
  const bystander = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, author.id, "participant");
  await addTripMember(trip.id, bystander.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  const authorAccess = await requireTripAccess(trip.id, author);
  const bystanderAccess = await requireTripAccess(trip.id, bystander);
  return {
    trip,
    userIds: [planner.id, author.id, bystander.id],
    plannerAccess,
    authorAccess,
    bystanderAccess,
  };
}

test("createItem rejects a blank title and an end time before the start time", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await assert.rejects(() => createItem(authorAccess, { title: "   " }), RuleError);

  const startsAt = new Date("2026-06-01T18:00:00Z");
  const endsAt = new Date("2026-06-01T17:00:00Z");
  await assert.rejects(
    () => createItem(authorAccess, { title: "Dinner", startsAt, endsAt }),
    RuleError,
  );
});

test("createItem derives status from whether a time was given", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const idea = await createItem(authorAccess, { title: "Maybe the aquarium" });
  assert.equal(idea.status, "idea");

  const proposed = await createItem(authorAccess, {
    title: "Dinner reservation",
    startsAt: new Date("2026-06-01T18:00:00Z"),
  });
  assert.equal(proposed.status, "proposed");
});

test("updateItemDetails: the author may edit their own unlocked item; a bystander may not; a planner always may", async (t) => {
  const { trip, userIds, authorAccess, bystanderAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, { title: "Original title" });

  const byAuthor = await updateItemDetails(authorAccess, item.id, { title: "Author's edit" });
  assert.equal(byAuthor.title, "Author's edit");

  await assert.rejects(
    () => updateItemDetails(bystanderAccess, item.id, { title: "Bystander's edit" }),
    RuleError,
  );

  const byPlanner = await updateItemDetails(plannerAccess, item.id, { title: "Planner's edit" });
  assert.equal(byPlanner.title, "Planner's edit");
});

test("updateItemDetails: once locked, only the planner may edit -- not even the original author", async (t) => {
  const { trip, userIds, authorAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(authorAccess, (await createItem(authorAccess, { title: "Kayaking" })).id, new Date("2026-06-02T15:00:00Z"), null);
  const locked = await lockItem(plannerAccess, proposed.id, "optional");
  assert.equal(locked.status, "locked");

  await assert.rejects(
    () => updateItemDetails(authorAccess, locked.id, { title: "Author tries to rename it" }),
    RuleError,
  );

  const byPlanner = await updateItemDetails(plannerAccess, locked.id, { title: "Planner renames it" });
  assert.equal(byPlanner.title, "Planner renames it");
});

test("updateItemDetails deletes lodging_details when the category moves away from lodging", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, { title: "Hotel Riviera", category: "lodging" });
  await upsertLodgingDetails(authorAccess, item.id, { address: "1 Beach Rd" });

  const before = await db.select().from(lodgingDetails).where(eq(lodgingDetails.itemId, item.id));
  assert.equal(before.length, 1, "lodging details exist before the category change");

  await updateItemDetails(authorAccess, item.id, { category: "activity" });

  const after = await db.select().from(lodgingDetails).where(eq(lodgingDetails.itemId, item.id));
  assert.equal(after.length, 0, "orphaned lodging details are cleaned up");
});

test("the idea -> proposed -> locked -> declined -> restored lifecycle persists correctly, and unlock wipes RSVPs", async (t) => {
  const { trip, userIds, authorAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const idea = await createItem(authorAccess, { title: "Group hike" });
  assert.equal(idea.status, "idea");

  const proposed = await scheduleItem(authorAccess, idea.id, new Date("2026-06-03T09:00:00Z"), null);
  assert.equal(proposed.status, "proposed");

  const backToIdea = await unscheduleItem(authorAccess, proposed.id);
  assert.equal(backToIdea.status, "idea");
  assert.equal(backToIdea.startsAt, null);

  const reproposed = await scheduleItem(authorAccess, idea.id, new Date("2026-06-03T09:00:00Z"), null);
  const locked = await lockItem(plannerAccess, reproposed.id, "optional");
  assert.equal(locked.status, "locked");
  assert.equal(locked.commitment, "optional");

  await setRsvp(authorAccess, locked.id, "yes");
  const rsvpsBefore = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, locked.id));
  assert.equal(rsvpsBefore.length, 1, "RSVP recorded while locked");

  const unlocked = await unlockItem(plannerAccess, locked.id);
  assert.equal(unlocked.status, "proposed", "an item with a time returns to proposed, not idea");
  assert.equal(unlocked.commitment, null);

  const rsvpsAfter = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, locked.id));
  assert.equal(rsvpsAfter.length, 0, "RSVPs are wiped -- they answered a plan that no longer exists");

  const declined = await declineItem(authorAccess, unlocked.id);
  assert.equal(declined.status, "declined");

  const restored = await restoreItem(authorAccess, declined.id);
  assert.equal(restored.status, "proposed", "restoring a timed item lands back on proposed");
});

test("setRsvp upserts -- a second response replaces the first, it doesn't add a row", async (t) => {
  const { trip, userIds, authorAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(authorAccess, (await createItem(authorAccess, { title: "Optional side trip" })).id, new Date("2026-06-04T10:00:00Z"), null);
  const locked = await lockItem(plannerAccess, proposed.id, "optional");

  await setRsvp(authorAccess, locked.id, "maybe");
  await setRsvp(authorAccess, locked.id, "yes");

  const rows = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, locked.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].response, "yes");
});

test("deleteItem: blocked while locked, and only the author or a planner may delete", async (t) => {
  const { trip, userIds, authorAccess, bystanderAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(authorAccess, (await createItem(authorAccess, { title: "Beach day" })).id, new Date("2026-06-05T11:00:00Z"), null);
  const locked = await lockItem(plannerAccess, proposed.id, "optional");

  await assert.rejects(() => deleteItem(plannerAccess, locked.id), RuleError, "can't delete while locked");

  const unlocked = await unlockItem(plannerAccess, locked.id);
  await assert.rejects(
    () => deleteItem(bystanderAccess, unlocked.id),
    RuleError,
    "a bystander -- neither author nor planner -- can't delete it",
  );

  // Author may delete their own unlocked item.
  await deleteItem(authorAccess, unlocked.id);
  await assert.rejects(
    () => getItem(authorAccess, unlocked.id),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
    "it's actually gone",
  );
});

test("category-specific details (dining_details) are also orphaned on a category change away from dining", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, { title: "Sushi place", category: "dining" });
  await db.insert(diningDetails).values({ itemId: item.id, cuisine: "Sushi" });

  await updateItemDetails(authorAccess, item.id, { category: "other" });

  const after = await db.select().from(diningDetails).where(eq(diningDetails.itemId, item.id));
  assert.equal(after.length, 0);
});
