import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { acceptInvite, createInvite, createTrip, tripsForUser } from "./trips.ts";
import { AccessError } from "./scope.ts";
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
