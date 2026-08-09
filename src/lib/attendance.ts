import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { itemRsvps } from "@/db/schema";
import type { Item, TripAccess, TripMemberSummary } from "./scope.ts";

export type Attendance = {
  attendees: TripMemberSummary[];
  /** Members who haven't answered yet. Empty for required items. */
  awaiting: TripMemberSummary[];
  declined: TripMemberSummary[];
  /** True when attendance follows from membership rather than an RSVP. */
  automatic: boolean;
};

/**
 * Attendance is computed, never stored. Required items put every current member
 * on the bus, so somebody who joins the trip late is included without a backfill.
 *
 * A private item belongs to one person, so it is attended by exactly its author
 * regardless of commitment.
 *
 * Proposals report attendance too, not just locked items. An "I'm in" is one
 * answer about one item and means the same thing on either side of a lock (see
 * lifecycle.ts's checkRsvp), so this is what lets PlaySpace show a planner who
 * actually wants something before they choose what to lock.
 */
export async function attendanceFor(
  access: TripAccess,
  item: Item,
): Promise<Attendance> {
  const none = { attendees: [], awaiting: [], declined: [], automatic: false };

  if (item.visibility === "private") {
    const author = access.members.find((m) => m.userId === item.createdBy);
    return { ...none, attendees: author ? [author] : [], automatic: true };
  }

  // Declined items keep their rows (see checkRsvp) but report nobody -- the
  // support is remembered for a restore, not counted while it's off the table.
  if (item.status === "declined") return none;

  if (item.commitment === "required") {
    return { ...none, attendees: access.members, automatic: true };
  }

  const [byUser] = await rsvpsForItems([item.id]);
  const responses = byUser?.responses ?? new Map<string, string>();

  return {
    attendees: access.members.filter((m) => responses.get(m.userId) === "yes"),
    declined: access.members.filter((m) => responses.get(m.userId) === "no"),
    awaiting: access.members.filter((m) => !responses.has(m.userId)),
    automatic: false,
  };
}

/** Batched lookup so an itinerary page doesn't issue one query per item. */
export async function rsvpsForItems(
  itemIds: string[],
): Promise<{ itemId: string; responses: Map<string, string> }[]> {
  if (itemIds.length === 0) return [];

  const rows = await db
    .select()
    .from(itemRsvps)
    .where(inArray(itemRsvps.itemId, itemIds));

  const grouped = new Map<string, Map<string, string>>();
  for (const id of itemIds) grouped.set(id, new Map());
  for (const row of rows) grouped.get(row.itemId)?.set(row.userId, row.response);

  return [...grouped].map(([itemId, responses]) => ({ itemId, responses }));
}

/**
 * Filters group items down to the ones a member is actually attending --
 * required items automatically (everyone's on the bus), optional items
 * only where they RSVP'd yes. Same rule conflictsForViewer uses to build a
 * timeline (see conflicts-for.ts): "My Itinerary" is exactly the set
 * analyzeTimeline would check conflicts against for this person, not just
 * an approximation of it. Doesn't handle private items -- those are
 * already scoped to their author by scope.ts's visibleToViewer, before
 * attendance ever enters the picture.
 */
export function attendingItems<T extends { id: string; commitment: Item["commitment"] }>(
  items: T[],
  rsvpMap: Map<string, Map<string, string>>,
  memberId: string,
): T[] {
  return items.filter((item) => {
    if (item.commitment === "required") return true;
    return rsvpMap.get(item.id)?.get(memberId) === "yes";
  });
}

export async function myRsvp(
  access: TripAccess,
  itemId: string,
): Promise<"yes" | "no" | "maybe" | null> {
  const [row] = await db
    .select({ response: itemRsvps.response })
    .from(itemRsvps)
    .where(and(eq(itemRsvps.itemId, itemId), eq(itemRsvps.userId, access.viewer.id)))
    .limit(1);
  return row?.response ?? null;
}
