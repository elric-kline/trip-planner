import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { invites, trips, tripMembers } from "@/db/schema";
import type { CurrentUser } from "./auth.ts";
import { AccessError, type MemberRole, type TripAccess } from "./scope.ts";
import { autoIncludeSoleLocations, seedDays } from "./days.ts";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type CreateTripInput = {
  name: string;
  destination: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  timezone: string;
};

export async function createTrip(owner: CurrentUser, input: CreateTripInput) {
  if (!input.name.trim()) throw new Error("Give the trip a name.");
  if (input.startDate > input.endDate)
    throw new Error("The trip can't end before it starts.");

  const [trip] = await db
    .insert(trips)
    .values({
      name: input.name.trim(),
      destination: input.destination.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      timezone: input.timezone,
      createdBy: owner.id,
    })
    .returning();

  await db
    .insert(tripMembers)
    .values({ tripId: trip.id, userId: owner.id, role: "master_planner" });

  // One trip_days row per calendar date, ready for the planner to fill in --
  // see days.ts's seedDays and schema.ts's tripDays for why this is seeded
  // once here rather than built up piecemeal.
  await seedDays(trip.id, trip.startDate, trip.endDate);

  return trip;
}

export async function tripsForUser(user: CurrentUser) {
  return db
    .select({ trip: trips, role: tripMembers.role })
    .from(tripMembers)
    .innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(eq(tripMembers.userId, user.id));
}

/**
 * Appoints a participant as co_planner, or revokes one back to
 * participant -- unlimited co-planners, no cap, matching "let the planner
 * appoint co-planners. Unlimited." Any existing planner (master or co) may
 * do this to any *other* member; co-planners get exactly the same
 * capabilities as the master everywhere else in the app (see scope.ts's
 * isPlanner), so there's no reason to additionally restrict who gets to
 * hand that out.
 *
 * The trip's original master_planner is permanently fixed (see schema.ts's
 * memberRole doc comment) -- can't be revoked, demoted, or reassigned,
 * including by themselves. That's what guarantees a trip can never end up
 * with zero planners; there's no "transfer ownership" or "leave the trip"
 * flow this needs to coordinate with.
 */
export async function setMemberRole(
  access: TripAccess,
  targetUserId: string,
  role: "co_planner" | "participant",
): Promise<void> {
  if (!access.isPlanner) throw new Error("Only a planner can change member roles.");

  const target = access.members.find((m) => m.userId === targetUserId);
  if (!target) throw new Error("That person isn't on this trip.");
  if (target.role === "master_planner") throw new Error("The trip's original planner can't be changed.");

  await db
    .update(tripMembers)
    .set({ role })
    .where(and(eq(tripMembers.tripId, access.trip.id), eq(tripMembers.userId, targetUserId)));
}

export async function createInvite(
  tripId: string,
  creator: CurrentUser,
  opts: { email?: string; role?: MemberRole } = {},
) {
  const token = randomBytes(24).toString("base64url");
  const [invite] = await db
    .insert(invites)
    .values({
      tripId,
      token,
      email: opts.email?.trim().toLowerCase() || null,
      role: opts.role ?? "participant",
      createdBy: creator.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();
  return invite;
}

/**
 * Redeems an invite for the given (already authenticated) user. An
 * email-scoped invite only works for that address — this is the one place we
 * check it, since anything downstream trusts trip membership without re-checking.
 */
export async function acceptInvite(token: string, user: CurrentUser) {
  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(eq(invites.token, token), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())),
    )
    .limit(1);

  if (!invite) throw new AccessError("NOT_FOUND", "This invite is invalid or has expired.");
  if (invite.email && invite.email !== user.email.toLowerCase()) {
    throw new AccessError(
      "FORBIDDEN",
      `This invite was sent to ${invite.email}. Sign in with that address to accept it.`,
    );
  }

  await db
    .insert(tripMembers)
    .values({ tripId: invite.tripId, userId: user.id, role: invite.role })
    .onConflictDoNothing();

  // Onboard them into whatever the trip has already planned, for the parts
  // that aren't actually in question -- see days.ts's autoIncludeSoleLocations.
  // Idempotent, so harmless to run again if this invite (or another one to
  // the same trip) was already accepted.
  await autoIncludeSoleLocations(invite.tripId, user.id);

  await db
    .update(invites)
    .set({ acceptedAt: new Date(), acceptedBy: user.id })
    .where(eq(invites.id, invite.id));

  return invite.tripId;
}
