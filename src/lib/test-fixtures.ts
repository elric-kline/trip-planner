import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { trips, tripMembers, users } from "@/db/schema";
import { createTrip, type CreateTripInput } from "./trips.ts";
import type { CurrentUser } from "./auth.ts";
import type { MemberRole } from "./scope.ts";

/**
 * Real-Postgres fixtures for integration tests. Not a *.test.ts file itself
 * (so `node --test`'s glob never tries to run it), just helpers the
 * integration suites share.
 *
 * These require DATABASE_URL to point at a real, migrated Postgres -- same
 * requirement `npm run db:migrate`/`db:seed` already have; see the "test:
 * integration" CI job for how that's provisioned. Every test that uses
 * these must clean up after itself via cleanupTrip() in a t.after() hook --
 * there's no test-wide transaction rollback here, since some of the code
 * under test (items.ts) opens its own separate queries mid-operation.
 */

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}-${randomBytes(4).toString("hex")}`;
}

/** A real user row -- no password, no session; enough to act as a CurrentUser. */
export async function createTestUser(overrides: { name?: string | null } = {}): Promise<CurrentUser> {
  const [user] = await db
    .insert(users)
    .values({ email: `${unique("user")}@example.test`, name: overrides.name ?? null })
    .returning();
  return { id: user.id, email: user.email, name: user.name };
}

/** Goes through the real createTrip() -- also seeds the owner as master_planner, same as production. */
export async function createTestTrip(owner: CurrentUser, overrides: Partial<CreateTripInput> = {}) {
  return createTrip(owner, {
    name: overrides.name ?? unique("Trip"),
    destination: overrides.destination ?? "Testville",
    startDate: overrides.startDate ?? "2026-01-01",
    endDate: overrides.endDate ?? "2026-01-05",
    timezone: overrides.timezone ?? "UTC",
  });
}

export async function addTripMember(
  tripId: string,
  userId: string,
  role: MemberRole = "participant",
): Promise<void> {
  await db.insert(tripMembers).values({ tripId, userId, role });
}

/**
 * Deletes a trip (cascades items, trip_members, invites, lodging_details,
 * dining_details -- see schema.ts's onDelete: "cascade" chains) then its
 * test users. Trip first: users.id is referenced by items.createdBy with no
 * cascade, so deleting a user while their items still exist would fail the
 * foreign key.
 */
export async function cleanupTrip(tripId: string, userIds: string[]): Promise<void> {
  await db.delete(trips).where(eq(trips.id, tripId));
  for (const id of userIds) {
    await db.delete(users).where(eq(users.id, id));
  }
}
