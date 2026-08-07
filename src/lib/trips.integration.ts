import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { acceptInvite, createInvite, createTrip, tripsForUser } from "./trips.ts";
import { AccessError, requireTripAccess } from "./scope.ts";
import { addLocation, listDays, locationMembersForLocations, unresolvedBranchesForMember } from "./days.ts";
import { createTestUser, createTestTrip, cleanupTrip } from "./test-fixtures.ts";

test("createTrip rejects a blank name and an end date before the start date", async (t) => {
  const owner = await createTestUser();
  t.after(() => db.delete(users).where(eq(users.id, owner.id)));

  await assert.rejects(() =>
    createTrip(owner, { name: "  ", destination: "Rome", startDate: "2026-01-01", endDate: "2026-01-05", timezone: "UTC" }),
  );
  await assert.rejects(() =>
    createTrip(owner, { name: "Rome trip", destination: "Rome", startDate: "2026-01-05", endDate: "2026-01-01", timezone: "UTC" }),
  );
});

test("createTrip seeds the owner as master_planner, and tripsForUser reflects it", async (t) => {
  const owner = await createTestUser();
  const trip = await createTestTrip(owner);
  t.after(() => cleanupTrip(trip.id, [owner.id]));

  const mine = await tripsForUser(owner);
  const row = mine.find((r) => r.trip.id === trip.id);
  assert.ok(row, "the trip shows up for its owner");
  assert.equal(row?.role, "master_planner");
});

test("createInvite + acceptInvite: an email-scoped invite only works for that address", async (t) => {
  const owner = await createTestUser();
  const invitee = await createTestUser();
  const stranger = await createTestUser();
  const trip = await createTestTrip(owner);
  t.after(() => cleanupTrip(trip.id, [owner.id, invitee.id, stranger.id]));

  const invite = await createInvite(trip.id, owner, { email: invitee.email.toUpperCase() });

  await assert.rejects(
    () => acceptInvite(invite.token, stranger),
    (err: unknown) => err instanceof AccessError && err.kind === "FORBIDDEN",
  );

  const tripId = await acceptInvite(invite.token, invitee);
  assert.equal(tripId, trip.id);

  const memberships = await tripsForUser(invitee);
  assert.ok(memberships.some((r) => r.trip.id === trip.id));
});

test("an invite with no email is a shareable link -- anyone may accept it", async (t) => {
  const owner = await createTestUser();
  const anyone = await createTestUser();
  const trip = await createTestTrip(owner);
  t.after(() => cleanupTrip(trip.id, [owner.id, anyone.id]));

  const invite = await createInvite(trip.id, owner);
  const tripId = await acceptInvite(invite.token, anyone);
  assert.equal(tripId, trip.id);
});

test("acceptInvite rejects an unknown token, and a token is genuinely single-use", async (t) => {
  const owner = await createTestUser();
  const invitee = await createTestUser();
  const trip = await createTestTrip(owner);
  t.after(() => cleanupTrip(trip.id, [owner.id, invitee.id]));

  await assert.rejects(
    () => acceptInvite("this-token-does-not-exist", invitee),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
  );

  const invite = await createInvite(trip.id, owner);
  await acceptInvite(invite.token, invitee);

  // The token's own acceptedAt is now set, so its own SELECT (isNull(acceptedAt))
  // no longer matches -- a second accept fails the same way a bogus token
  // does, not a silent no-op. Membership itself was already granted once.
  await assert.rejects(
    () => acceptInvite(invite.token, invitee),
    (err: unknown) => err instanceof AccessError && err.kind === "NOT_FOUND",
  );

  const memberships = await tripsForUser(invitee);
  assert.equal(memberships.filter((r) => r.trip.id === trip.id).length, 1);
});

test("acceptInvite auto-includes a new member into every day-location group that has no real choice to make", async (t) => {
  const owner = await createTestUser();
  const invitee = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id, invitee.id]));

  const ownerAccess = await requireTripAccess(trip.id, owner);
  const [day] = await listDays(ownerAccess);
  // A single wake location -- no ambiguity, so a new member should just be
  // added to it, same as if they'd been there when it was created.
  const wake = await addLocation(ownerAccess, day.id, "wake", { name: "Seattle, WA" });

  const invite = await createInvite(trip.id, owner);
  await acceptInvite(invite.token, invitee);

  const members = await locationMembersForLocations([wake.id]);
  assert.deepEqual(new Set(members.get(wake.id)), new Set([owner.id, invitee.id]));

  const branches = await unresolvedBranchesForMember(trip.id, invitee.id);
  assert.deepEqual(branches, [], "nothing left for the wizard to ask -- there was no real fork");
});

test("acceptInvite leaves an actual split day for the join wizard, not auto-resolved either way", async (t) => {
  const owner = await createTestUser();
  const invitee = await createTestUser();
  const trip = await createTestTrip(owner, { startDate: "2026-09-01", endDate: "2026-09-01" });
  t.after(() => cleanupTrip(trip.id, [owner.id, invitee.id]));

  const ownerAccess = await requireTripAccess(trip.id, owner);
  const [day] = await listDays(ownerAccess);
  const bethlehem = await addLocation(ownerAccess, day.id, "wake", { name: "Bethlehem, PA" });
  const nyc = await addLocation(ownerAccess, day.id, "wake", { name: "New York, NY" });

  const invite = await createInvite(trip.id, owner);
  await acceptInvite(invite.token, invitee);

  // Not silently dropped into either leg.
  const members = await locationMembersForLocations([bethlehem.id, nyc.id]);
  assert.ok(!(members.get(bethlehem.id) ?? []).includes(invitee.id));
  assert.ok(!(members.get(nyc.id) ?? []).includes(invitee.id));

  const branches = await unresolvedBranchesForMember(trip.id, invitee.id);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].kind, "wake");
  assert.deepEqual(
    new Set(branches[0].locations.map((l) => l.name)),
    new Set(["Bethlehem, PA", "New York, NY"]),
  );
});
