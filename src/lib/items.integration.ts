import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { diningDetails, itemRsvps, lodgingDetails, transportDetails, transportLegs } from "@/db/schema";
import {
  createItem,
  deleteItem,
  declineItem,
  lockItem,
  restoreItem,
  RuleError,
  scheduleItem,
  setRsvp,
  shareItem,
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
 * the side effects that ride along with each transition (support voided when
 * a required lock displaces a rival, category-specific details orphaned on a
 * category change). The
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

test("the idea -> proposed -> locked -> declined -> restored lifecycle persists correctly, and support survives an unlock", async (t) => {
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
  assert.equal(
    rsvpsAfter.length,
    1,
    "support survives an unlock -- it's one answer about one item, not about the lock",
  );

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

test("category-specific details (transport_details and transport_legs) are also orphaned on a category change away from transport", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, { title: "Connecting flight", category: "transport" });
  await db.insert(transportDetails).values({ itemId: item.id, subtype: "flight" });
  await db.insert(transportLegs).values({
    itemId: item.id,
    legOrder: 0,
    departsAt: new Date("2026-08-10T08:00:00Z"),
    arrivesAt: new Date("2026-08-10T10:00:00Z"),
  });

  await updateItemDetails(authorAccess, item.id, { category: "other" });

  const afterDetails = await db.select().from(transportDetails).where(eq(transportDetails.itemId, item.id));
  assert.equal(afterDetails.length, 0);
  const afterLegs = await db.select().from(transportLegs).where(eq(transportLegs.itemId, item.id));
  assert.equal(afterLegs.length, 0, "legs reference the item directly, not transport_details, so they need their own cleanup");
});

test("shareItem: moves a private idea to group, author-only, and blocked once already shared", async (t) => {
  const { trip, userIds, authorAccess, bystanderAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const scratchpadIdea = await createItem(authorAccess, { title: "Secret waterfall hike", visibility: "private" });
  assert.equal(scratchpadIdea.visibility, "private");

  // A bystander can't even see someone else's private item -- visibleToViewer
  // (scope.ts) never returns it, so this 404s before checkShare's own
  // author-only rule is reached. That rule is still real (see
  // lifecycle.test.ts's isolated coverage of checkShare); it just can't be
  // exercised end-to-end here, because the privacy boundary it backs up is
  // already enforced one layer earlier.
  await assert.rejects(
    () => shareItem(bystanderAccess, scratchpadIdea.id),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
    "not the author -- can't even see someone else's private idea",
  );

  const shared = await shareItem(authorAccess, scratchpadIdea.id);
  assert.equal(shared.visibility, "group");

  await assert.rejects(
    () => shareItem(authorAccess, shared.id),
    RuleError,
    "already shared -- nothing left to do",
  );
});

test("shareItem: a locked private item must be unlocked first", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const proposed = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "My own quiet morning run", visibility: "private" })).id,
    new Date("2026-06-06T06:00:00Z"),
    null,
  );
  // lockPrivateItemAction (actions.ts) is just lockItem with a null
  // commitment -- a private item has no commitment to choose -- so this
  // exercises the same rule (checkLock's private branch) straight through
  // items.ts, independent of the actions.ts wiring.
  const locked = await lockItem(authorAccess, proposed.id, null);
  assert.equal(locked.status, "locked");
  assert.equal(locked.visibility, "private");

  await assert.rejects(() => shareItem(authorAccess, locked.id), RuleError, "must unlock before sharing");

  const unlocked = await unlockItem(authorAccess, locked.id);
  const shared = await shareItem(authorAccess, unlocked.id);
  assert.equal(shared.visibility, "group");
});

test("locking as required voids the support on whatever it displaces", async (t) => {
  const { trip, userIds, authorAccess, bystanderAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  // Two rival proposals for the same afternoon, plus one that doesn't clash.
  const ruins = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Monte Alban ruins" })).id,
    new Date("2026-06-06T13:00:00Z"),
    new Date("2026-06-06T17:00:00Z"),
  );
  const waterfall = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Hierve el Agua" })).id,
    new Date("2026-06-06T14:00:00Z"),
    new Date("2026-06-06T18:00:00Z"),
  );
  const dinner = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Dinner" })).id,
    new Date("2026-06-06T20:00:00Z"),
    new Date("2026-06-06T22:00:00Z"),
  );

  await setRsvp(bystanderAccess, waterfall.id, "yes");
  await setRsvp(bystanderAccess, dinner.id, "yes");

  await lockItem(plannerAccess, ruins.id, "required");

  const waterfallRsvps = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, waterfall.id));
  assert.equal(waterfallRsvps.length, 0, "the overlapping rival's support is voided");

  const dinnerRsvps = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, dinner.id));
  assert.equal(dinnerRsvps.length, 1, "a proposal that doesn't clash is untouched");
});

test("locking as optional leaves rival support alone", async (t) => {
  const { trip, userIds, authorAccess, bystanderAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const ruins = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Ruins" })).id,
    new Date("2026-06-07T13:00:00Z"),
    new Date("2026-06-07T17:00:00Z"),
  );
  const waterfall = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Waterfall" })).id,
    new Date("2026-06-07T14:00:00Z"),
    new Date("2026-06-07T18:00:00Z"),
  );
  await setRsvp(bystanderAccess, waterfall.id, "yes");

  // Optional doesn't put anyone on the bus, so nothing has been displaced --
  // both can still be wanted, and the conflict banner is what says so.
  await lockItem(plannerAccess, ruins.id, "optional");

  const rows = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, waterfall.id));
  assert.equal(rows.length, 1);
});

test("a required lock doesn't touch support on an already-locked overlap", async (t) => {
  const { trip, userIds, authorAccess, bystanderAccess, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const optional = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Optional tour" })).id,
    new Date("2026-06-08T14:00:00Z"),
    new Date("2026-06-08T18:00:00Z"),
  );
  const lockedOptional = await lockItem(plannerAccess, optional.id, "optional");
  await setRsvp(bystanderAccess, lockedOptional.id, "yes");

  const clash = await scheduleItem(
    authorAccess,
    (await createItem(authorAccess, { title: "Mandatory briefing" })).id,
    new Date("2026-06-08T15:00:00Z"),
    new Date("2026-06-08T16:00:00Z"),
  );
  await lockItem(plannerAccess, clash.id, "required");

  const rows = await db.select().from(itemRsvps).where(eq(itemRsvps.itemId, lockedOptional.id));
  assert.equal(
    rows.length,
    1,
    "already-agreed plans keep their answers -- that clash is the conflict banner's job, not a silent void",
  );
});
