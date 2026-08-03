import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { invites, trips, tripMembers } from "@/db/schema";
import type { CurrentUser } from "./auth.ts";
import { AccessError } from "./scope.ts";

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

  return trip;
}

export async function tripsForUser(user: CurrentUser) {
  return db
    .select({ trip: trips, role: tripMembers.role })
    .from(tripMembers)
    .innerJoin(trips, eq(trips.id, tripMembers.tripId))
    .where(eq(tripMembers.userId, user.id));
}

export async function createInvite(
  tripId: string,
  creator: CurrentUser,
  opts: { email?: string; role?: "master_planner" | "participant" } = {},
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

  await db
    .update(invites)
    .set({ acceptedAt: new Date(), acceptedBy: user.id })
    .where(eq(invites.id, invite.id));

  return invite.tripId;
}
