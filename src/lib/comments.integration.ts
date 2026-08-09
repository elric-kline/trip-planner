import { test } from "node:test";
import assert from "node:assert/strict";
import { addComment, deleteComment, listComments } from "./comments.ts";
import { createItem } from "./items.ts";
import { AccessError, requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

/**
 * Comments carry no visibility rule of their own -- they inherit the item's,
 * via getItem. These tests exist mostly to prove that inheritance actually
 * holds, since a second parallel rule is exactly the thing that drifts.
 */
async function setupTrip() {
  const planner = await createTestUser();
  const member = await createTestUser();
  const outsider = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, member.id, "participant");
  const otherTrip = await createTestTrip(outsider);
  return {
    trip,
    otherTrip,
    userIds: [planner.id, member.id, outsider.id],
    planner,
    member,
    plannerAccess: await requireTripAccess(trip.id, planner),
    memberAccess: await requireTripAccess(trip.id, member),
    outsiderAccess: await requireTripAccess(otherTrip.id, outsider),
  };
}

test("anyone on the trip can comment, and the thread reads oldest first", async (t) => {
  const { trip, otherTrip, userIds, plannerAccess, memberAccess } = await setupTrip();
  t.after(async () => {
    await cleanupTrip(trip.id, []);
    await cleanupTrip(otherTrip.id, userIds);
  });

  const item = await createItem(plannerAccess, { title: "Monte Alban" });
  await addComment(plannerAccess, item.id, "Worth the early start?");
  await addComment(memberAccess, item.id, "Yes -- go before the coaches arrive.");

  const thread = await listComments(memberAccess, item.id);
  assert.deepEqual(
    thread.map((c) => c.body),
    ["Worth the early start?", "Yes -- go before the coaches arrive."],
  );
  assert.equal(thread[1].authorEmail, memberAccess.viewer.email);
});

test("a blank comment is refused, whitespace and all", async (t) => {
  const { trip, otherTrip, userIds, plannerAccess } = await setupTrip();
  t.after(async () => {
    await cleanupTrip(trip.id, []);
    await cleanupTrip(otherTrip.id, userIds);
  });

  const item = await createItem(plannerAccess, { title: "Somewhere" });
  await assert.rejects(() => addComment(plannerAccess, item.id, "   \n  "));
  assert.deepEqual(await listComments(plannerAccess, item.id), []);
});

test("comments inherit the item's own visibility rather than a rule of their own", async (t) => {
  const { trip, otherTrip, userIds, plannerAccess, memberAccess, outsiderAccess } = await setupTrip();
  t.after(async () => {
    await cleanupTrip(trip.id, []);
    await cleanupTrip(otherTrip.id, userIds);
  });

  const shared = await createItem(plannerAccess, { title: "Group dinner" });
  await assert.rejects(
    () => listComments(outsiderAccess, shared.id),
    AccessError,
    "somebody on another trip can't read the thread",
  );

  const secret = await createItem(plannerAccess, { title: "Surprise", visibility: "private" });
  await addComment(plannerAccess, secret.id, "Don't tell them.");
  await assert.rejects(
    () => listComments(memberAccess, secret.id),
    AccessError,
    "a private item's thread is as private as the item",
  );
});

test("a comment can be deleted by its author or a planner, and by nobody else", async (t) => {
  const { trip, otherTrip, userIds, plannerAccess, memberAccess } = await setupTrip();
  t.after(async () => {
    await cleanupTrip(trip.id, []);
    await cleanupTrip(otherTrip.id, userIds);
  });

  const item = await createItem(plannerAccess, { title: "Beach" });
  const byMember = await addComment(memberAccess, item.id, "I'd rather not.");
  const byPlanner = await addComment(plannerAccess, item.id, "Noted.");

  await assert.rejects(
    () => deleteComment(memberAccess, byPlanner.id),
    /Only its author, or a planner/,
    "a participant can't delete somebody else's comment",
  );

  await deleteComment(memberAccess, byMember.id);
  await deleteComment(plannerAccess, byPlanner.id);
  assert.deepEqual(await listComments(plannerAccess, item.id), []);
});

test("deleting an item takes its thread with it", async (t) => {
  const { trip, otherTrip, userIds, plannerAccess } = await setupTrip();
  t.after(async () => {
    await cleanupTrip(trip.id, []);
    await cleanupTrip(otherTrip.id, userIds);
  });

  const item = await createItem(plannerAccess, { title: "Doomed idea" });
  await addComment(plannerAccess, item.id, "On reflection, no.");

  const { deleteItem } = await import("./items.ts");
  await deleteItem(plannerAccess, item.id);

  await assert.rejects(() => listComments(plannerAccess, item.id), AccessError);
});
