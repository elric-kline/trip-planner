import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AccessError,
  canEditItem,
  canLockItem,
  getItem,
  listItems,
  requireTripAccess,
} from "./scope.ts";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createItem } from "./items.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

/**
 * Integration coverage for the authorization layer -- who can see what, and
 * who can edit or lock it. This is the highest-value place for a real
 * regression test in the whole app: a silent bug here means a private plan
 * leaks, or an item someone shouldn't be able to touch becomes editable.
 * Runs against a real, migrated Postgres (see test-fixtures.ts and the CI
 * "test:integration" job) rather than mocks -- these functions are thin
 * wrappers around real SQL, so a mock would just re-assert my own
 * assumptions about what the query does instead of checking it.
 */

test("requireTripAccess throws NOT_FOUND for a trip id that doesn't exist", async (t) => {
  const viewer = await createTestUser();
  t.after(() => db.delete(users).where(eq(users.id, viewer.id)));

  await assert.rejects(
    () => requireTripAccess(randomUUID(), viewer),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
  );
});

test("requireTripAccess throws NOT_FOUND -- not FORBIDDEN -- for a real trip the viewer isn't on", async (t) => {
  const owner = await createTestUser();
  const outsider = await createTestUser();
  const trip = await createTestTrip(owner);
  t.after(() => cleanupTrip(trip.id, [owner.id, outsider.id]));

  // Deliberately NOT_FOUND: a non-member shouldn't be able to distinguish
  // "this trip doesn't exist" from "this trip exists but isn't yours" --
  // see scope.ts's own comment on requireTripAccess.
  await assert.rejects(
    () => requireTripAccess(trip.id, outsider),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
  );
});

test("the trip creator is a planner; an invited participant is not", async (t) => {
  const owner = await createTestUser();
  const participant = await createTestUser();
  const trip = await createTestTrip(owner);
  await addTripMember(trip.id, participant.id, "participant");
  t.after(() => cleanupTrip(trip.id, [owner.id, participant.id]));

  const ownerAccess = await requireTripAccess(trip.id, owner);
  assert.equal(ownerAccess.isPlanner, true);
  assert.equal(ownerAccess.role, "master_planner");

  const participantAccess = await requireTripAccess(trip.id, participant);
  assert.equal(participantAccess.isPlanner, false);
  assert.equal(participantAccess.role, "participant");
});

test("a private item is visible to its author, invisible to a co-member, in both listItems and getItem", async (t) => {
  const owner = await createTestUser();
  const other = await createTestUser();
  const trip = await createTestTrip(owner);
  await addTripMember(trip.id, other.id, "participant");
  t.after(() => cleanupTrip(trip.id, [owner.id, other.id]));

  const ownerAccess = await requireTripAccess(trip.id, owner);
  const privateItem = await createItem(ownerAccess, {
    title: "A private plan",
    visibility: "private",
  });

  const ownItems = await listItems(ownerAccess);
  assert.ok(ownItems.some((i) => i.id === privateItem.id), "author sees their own private item");
  assert.equal(await getItem(ownerAccess, privateItem.id).then((i) => i.id), privateItem.id);

  const otherAccess = await requireTripAccess(trip.id, other);
  const othersView = await listItems(otherAccess);
  assert.ok(!othersView.some((i) => i.id === privateItem.id), "co-member does not see it in listItems");
  await assert.rejects(
    () => getItem(otherAccess, privateItem.id),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
    "co-member gets NOT_FOUND, not a 403, fetching it directly",
  );
});

test("canEditItem: author owns an unlocked item; once locked, only a planner may edit it", async (t) => {
  const planner = await createTestUser();
  const author = await createTestUser();
  const bystander = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, author.id, "participant");
  await addTripMember(trip.id, bystander.id, "participant");
  t.after(() => cleanupTrip(trip.id, [planner.id, author.id, bystander.id]));

  const authorAccess = await requireTripAccess(trip.id, author);
  const item = await createItem(authorAccess, { title: "Museum visit" });

  assert.equal(canEditItem(authorAccess, item), true, "author edits their own unlocked item");

  const bystanderAccess = await requireTripAccess(trip.id, bystander);
  assert.equal(canEditItem(bystanderAccess, item), false, "another participant may not");

  const plannerAccess = await requireTripAccess(trip.id, planner);
  assert.equal(canEditItem(plannerAccess, item), true, "the planner always may");

  const locked = { ...item, status: "locked" as const };
  assert.equal(canEditItem(authorAccess, locked), false, "once locked, even the author is locked out");
  assert.equal(canEditItem(plannerAccess, locked), true, "...but the planner still isn't");
});

test("canLockItem is planner-only", async (t) => {
  const planner = await createTestUser();
  const participant = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, participant.id, "participant");
  t.after(() => cleanupTrip(trip.id, [planner.id, participant.id]));

  assert.equal(canLockItem(await requireTripAccess(trip.id, planner)), true);
  assert.equal(canLockItem(await requireTripAccess(trip.id, participant)), false);
});
