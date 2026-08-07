import { test } from "node:test";
import assert from "node:assert/strict";
import { createItem, RuleError, scheduleItem } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { listDays } from "./days.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

/**
 * Integration coverage for linking items to trip days: explicit placement
 * from the day-scoped "+ Add" UI (createItem's dayId/afterItemId), and
 * automatic grounding + chronological resnapping the moment an item gets a
 * startsAt (createItem with a time, and scheduleItem) -- see items.ts's
 * placeInDay/computeDayPosition/chronoPositionInDay for the logic this
 * exercises. The default test trip spans 2026-01-01..2026-01-05 (see
 * test-fixtures.ts's createTestTrip), so every date used here falls inside
 * that span unless a test is specifically checking the out-of-range case.
 */

async function setupTrip() {
  const planner = await createTestUser();
  const author = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, author.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  const authorAccess = await requireTripAccess(trip.id, author);
  const days = await listDays(plannerAccess);
  return { trip, userIds: [planner.id, author.id], plannerAccess, authorAccess, days };
}

test("createItem with an explicit dayId links the item and gives it dayPosition 0 when it's first", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, { title: "Ferry to Victoria", dayId: days[0].id });
  assert.equal(item.dayId, days[0].id);
  assert.equal(item.dayPosition, 0);
  assert.equal(item.status, "idea", "still untimed -- linking to a day alone doesn't schedule it");
});

test("createItem with dayId + afterItemId inserts between existing siblings via a midpoint position", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const first = await createItem(authorAccess, { title: "Breakfast", dayId: days[0].id });
  const third = await createItem(authorAccess, { title: "Dinner", dayId: days[0].id });
  assert.equal(first.dayPosition, 0);
  assert.equal(third.dayPosition, 1);

  const second = await createItem(authorAccess, {
    title: "Lunch",
    dayId: days[0].id,
    afterItemId: first.id,
  });
  assert.ok(second.dayPosition! > first.dayPosition! && second.dayPosition! < third.dayPosition!);
});

test("createItem rejects a dayId from a different trip, and an unknown dayId", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  const otherTrip = await createTestTrip(await createTestUser());
  t.after(() =>
    cleanupTrip(otherTrip.id, [otherTrip.createdBy]).then(() => cleanupTrip(trip.id, userIds)),
  );

  await assert.rejects(
    () => createItem(authorAccess, { title: "Wrong trip", dayId: otherTrip.id }),
    RuleError,
  );
  await assert.rejects(
    () => createItem(authorAccess, { title: "Made up day", dayId: "00000000-0000-0000-0000-000000000000" }),
    RuleError,
  );
});

test("createItem rejects an afterItemId that isn't actually a sibling in that day", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const elsewhere = await createItem(authorAccess, { title: "On a different day", dayId: days[1].id });
  await assert.rejects(
    () => createItem(authorAccess, { title: "Bogus insert", dayId: days[0].id, afterItemId: elsewhere.id }),
    RuleError,
  );
});

test("createItem with a startsAt but no dayId auto-grounds to the matching trip day", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, {
    title: "Museum",
    startsAt: new Date("2026-01-02T15:00:00Z"),
  });
  assert.equal(item.dayId, days[1].id, "Jan 2 matches the second seeded day");
  assert.equal(item.status, "proposed");
  assert.equal(item.dayPosition, 0);
});

test("createItem with a startsAt outside the trip's date range stays ungrounded, not invisible", async (t) => {
  const { trip, userIds, authorAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, {
    title: "Pre-trip errand",
    startsAt: new Date("2025-12-25T15:00:00Z"),
  });
  assert.equal(item.dayId, null);
  assert.equal(item.status, "proposed", "it's still a real proposal, just not grounded to a day");
});

test("createItem with both an explicit dayId and a startsAt lets the time govern position, not afterItemId", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const early = await createItem(authorAccess, {
    title: "9am kayaking",
    dayId: days[0].id,
    startsAt: new Date("2026-01-01T09:00:00Z"),
  });
  const late = await createItem(authorAccess, {
    title: "6pm dinner",
    dayId: days[0].id,
    startsAt: new Date("2026-01-01T18:00:00Z"),
  });
  // Insert a noon item "after" the 6pm one manually -- time should still win and slot it in the middle.
  const noon = await createItem(authorAccess, {
    title: "Noon lunch",
    dayId: days[0].id,
    afterItemId: late.id,
    startsAt: new Date("2026-01-01T12:00:00Z"),
  });
  assert.ok(noon.dayPosition! > early.dayPosition! && noon.dayPosition! < late.dayPosition!);
});

test("scheduleItem auto-grounds a previously dayless idea into the matching trip day", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const idea = await createItem(authorAccess, { title: "Group hike" });
  assert.equal(idea.dayId, null);

  const scheduled = await scheduleItem(authorAccess, idea.id, new Date("2026-01-03T09:00:00Z"), null);
  assert.equal(scheduled.dayId, days[2].id);
  assert.equal(scheduled.status, "proposed");
});

test("scheduleItem resnaps an already-day-linked item's position among its day's timed siblings", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const morning = await createItem(authorAccess, {
    title: "Morning coffee",
    dayId: days[0].id,
    startsAt: new Date("2026-01-01T08:00:00Z"),
  });
  const evening = await createItem(authorAccess, {
    title: "Evening show",
    dayId: days[0].id,
    startsAt: new Date("2026-01-01T20:00:00Z"),
  });
  // Manually added with no time yet -- lands at the end of the manual order.
  const untimed = await createItem(authorAccess, { title: "Maybe a museum stop", dayId: days[0].id });
  assert.ok(untimed.dayPosition! > evening.dayPosition!);

  // Now give it an afternoon time -- it should resnap between morning and evening.
  const scheduled = await scheduleItem(authorAccess, untimed.id, new Date("2026-01-01T14:00:00Z"), null);
  assert.equal(scheduled.dayId, days[0].id, "stays on the same day");
  assert.ok(
    scheduled.dayPosition! > morning.dayPosition! && scheduled.dayPosition! < evening.dayPosition!,
    "resnapped to sit chronologically between the two timed siblings",
  );
});

test("scheduleItem leaves an already-day-linked item's manual position alone when it's the only item with a time", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const first = await createItem(authorAccess, { title: "First thing", dayId: days[0].id });
  const target = await createItem(authorAccess, { title: "Second thing", dayId: days[0].id });
  assert.ok(target.dayPosition! > first.dayPosition!);

  const scheduled = await scheduleItem(authorAccess, target.id, new Date("2026-01-01T10:00:00Z"), null);
  assert.equal(scheduled.dayPosition, target.dayPosition, "nothing timed to resnap against -- position unchanged");
});

test("scheduleItem never moves an already-day-linked item to a different day, even if the new date disagrees", async (t) => {
  const { trip, userIds, authorAccess, days } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const item = await createItem(authorAccess, { title: "Placed on day 1 on purpose", dayId: days[0].id });
  const scheduled = await scheduleItem(authorAccess, item.id, new Date("2026-01-04T09:00:00Z"), null);
  assert.equal(scheduled.dayId, days[0].id, "the planner's manual placement wins over the time's own date");
});
