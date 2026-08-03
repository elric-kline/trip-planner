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

  if (item.status !== "locked") return none;

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
