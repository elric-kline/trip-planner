import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictsForViewer, groupTimelineFor, previewLockImpact } from "./conflicts-for.ts";
import { flagged } from "./conflicts.ts";
import { createItem, lockItem, scheduleItem, setRsvp } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

async function setupTrip() {
  const planner = await createTestUser();
  const memberA = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, memberA.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  const memberAAccess = await requireTripAccess(trip.id, memberA);
  return { trip, userIds: [planner.id, memberA.id], planner, memberA, plannerAccess, memberAAccess };
}

async function lockedRequired(access: Awaited<ReturnType<typeof requireTripAccess>>, title: string, startsAt: Date) {
  const created = await createItem(access, { title });
  const proposed = await scheduleItem(access, created.id, startsAt, null);
  return lockItem(access, proposed.id, "required");
}

test("conflictsForViewer flags two overlapping required items as a conflict", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Museum tour", new Date("2026-09-01T09:00:00Z")); // occupies 9:00-10:00 (default duration)
  await lockedRequired(plannerAccess, "Cooking class", new Date("2026-09-01T09:30:00Z")); // overlaps it

  const findings = flagged(await conflictsForViewer(plannerAccess));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "conflict");
  assert.equal(findings[0].reason, "overlap");
});

test("conflictsForViewer excludes an optional item the viewer hasn't RSVP'd yes to", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Required stop", new Date("2026-09-02T09:00:00Z"));
  const optionalProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Optional overlapping stop" })).id,
    new Date("2026-09-02T09:30:00Z"),
    null,
  );
  const optional = await lockItem(plannerAccess, optionalProposed.id, "optional");

  // Not RSVP'd yet -- the optional item isn't in the viewer's attending timeline.
  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 0);

  await setRsvp(plannerAccess, optional.id, "yes");
  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 1, "now it counts");
});

test("conflictsForViewer includes the viewer's own private items -- that's the one place private plans enter conflict math", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Group activity", new Date("2026-09-03T09:00:00Z"));

  const privateProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "My own overlapping errand", visibility: "private" })).id,
    new Date("2026-09-03T09:30:00Z"),
    null,
  );
  // A private item is locked by its own author, with no commitment.
  await lockItem(plannerAccess, privateProposed.id, null);

  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 1);
});

test("groupTimelineFor: required items always included; optional items only when the member RSVP'd yes", async (t) => {
  const { trip, userIds, plannerAccess, memberA } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const required = await lockedRequired(plannerAccess, "Required", new Date("2026-09-04T09:00:00Z"));
  const optionalProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Optional" })).id,
    new Date("2026-09-04T11:00:00Z"),
    null,
  );
  const optional = await lockItem(plannerAccess, optionalProposed.id, "optional");

  const groupItems = [required, optional];
  const noRsvps = new Map<string, Map<string, string>>();
  const withoutRsvp = await groupTimelineFor(memberA.id, groupItems, noRsvps);
  assert.deepEqual(withoutRsvp.map((i) => i.id), [required.id]);

  const withYes = new Map([[optional.id, new Map([[memberA.id, "yes"]])]]);
  const withRsvp = await groupTimelineFor(memberA.id, groupItems, withYes);
  assert.equal(withRsvp.length, 2);
});

test("previewLockImpact: no time or a private candidate means nothing to preview", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const idea = await createItem(plannerAccess, { title: "No time yet" });
  assert.deepEqual(await previewLockImpact(plannerAccess, idea, "required"), []);

  const privateProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Private candidate", visibility: "private" })).id,
    new Date("2026-09-05T09:00:00Z"),
    null,
  );
  assert.deepEqual(await previewLockImpact(plannerAccess, privateProposed, "required"), []);
});

test("previewLockImpact: locking a required candidate that overlaps an existing item surfaces the new conflict for every member", async (t) => {
  const { trip, userIds, plannerAccess, memberA } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Already locked", new Date("2026-09-06T09:00:00Z"));
  const candidate = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "About to lock, overlapping" })).id,
    new Date("2026-09-06T09:30:00Z"),
    null,
  );

  const impacts = await previewLockImpact(plannerAccess, candidate, "required");
  const affectedIds = impacts.map((i) => i.member.userId).sort();
  assert.deepEqual(affectedIds, [memberA.id, plannerAccess.viewer.id].sort());
  for (const impact of impacts) {
    assert.ok(impact.newFindings.length > 0);
  }
});
