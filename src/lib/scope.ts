import { and, asc, eq, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { items, tripMembers, trips, users } from "@/db/schema";
import type { CurrentUser } from "./auth.ts";
import { derivePhase, type TripPhase } from "./phase.ts";

export type MemberRole = "master_planner" | "participant";

export type TripMemberSummary = {
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
};

export type Trip = typeof trips.$inferSelect;
export type Item = typeof items.$inferSelect;

/**
 * Proof that a particular viewer may look at a particular trip, plus the facts
 * every downstream query needs. Obtain one of these before touching items.
 */
export type TripAccess = {
  trip: Trip;
  viewer: CurrentUser;
  role: MemberRole;
  isPlanner: boolean;
  members: TripMemberSummary[];
  phase: TripPhase;
};

export class AccessError extends Error {
  constructor(readonly kind: "NOT_FOUND" | "FORBIDDEN", message?: string) {
    super(message ?? kind);
  }
}

export async function requireTripAccess(
  tripId: string,
  viewer: CurrentUser,
): Promise<TripAccess> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  // Deliberately NOT_FOUND rather than FORBIDDEN — a non-member shouldn't be
  // able to probe which trip ids exist.
  if (!trip) throw new AccessError("NOT_FOUND");

  const members = await db
    .select({
      userId: tripMembers.userId,
      email: users.email,
      name: users.name,
      role: tripMembers.role,
    })
    .from(tripMembers)
    .innerJoin(users, eq(users.id, tripMembers.userId))
    .where(eq(tripMembers.tripId, tripId))
    .orderBy(asc(tripMembers.joinedAt));

  const me = members.find((m) => m.userId === viewer.id);
  if (!me) throw new AccessError("NOT_FOUND");

  return {
    trip,
    viewer,
    role: me.role,
    isPlanner: me.role === "master_planner",
    members,
    phase: derivePhase(trip),
  };
}

/**
 * The single definition of what a viewer may see. Private items are visible
 * only to their author — including in listings, counts and conflict math.
 *
 * Every read of `items` must AND this in. There is no other item query in the
 * codebase, and adding one that skips this is how private plans leak.
 */
export function visibleToViewer(access: TripAccess): SQL {
  return and(
    eq(items.tripId, access.trip.id),
    or(eq(items.visibility, "group"), eq(items.createdBy, access.viewer.id)),
  )!;
}

export type ListItemsOptions = {
  status?: Item["status"] | Item["status"][];
};

export async function listItems(
  access: TripAccess,
  opts: ListItemsOptions = {},
): Promise<Item[]> {
  const filters: SQL[] = [visibleToViewer(access)];

  if (opts.status) {
    const wanted = Array.isArray(opts.status) ? opts.status : [opts.status];
    const statusFilter = or(...wanted.map((s) => eq(items.status, s)));
    if (statusFilter) filters.push(statusFilter);
  }

  return db
    .select()
    .from(items)
    .where(and(...filters))
    .orderBy(asc(items.startsAt), asc(items.createdAt));
}

export async function getItem(access: TripAccess, itemId: string): Promise<Item> {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), visibleToViewer(access)))
    .limit(1);
  if (!item) throw new AccessError("NOT_FOUND");
  return item;
}

/**
 * Who may edit an item's own fields. The author keeps control until the
 * Master Planner locks it; after that the planner owns it.
 */
export function canEditItem(access: TripAccess, item: Item): boolean {
  if (item.status === "locked") return access.isPlanner;
  return item.createdBy === access.viewer.id || access.isPlanner;
}

/** Locking, unlocking, and setting required/optional are planner-only. */
export function canLockItem(access: TripAccess): boolean {
  return access.isPlanner;
}
