import type { TravelTimeProvider } from "./travel.ts";
import { HaversineTravelTimeProvider } from "./travel.ts";
import { analyzeTimeline, DEFAULT_DURATION_MINUTES, flagged, type ScheduleFinding, type ScheduleItem } from "./conflicts.ts";
import { rsvpsForItems } from "./attendance.ts";
import { listItems, type Item, type TripAccess, type TripMemberSummary } from "./scope.ts";

function toScheduleItem(item: Item): ScheduleItem {
  return {
    id: item.id,
    title: item.title,
    startsAt: item.startsAt!,
    endsAt: item.endsAt ?? new Date(item.startsAt!.getTime() + DEFAULT_DURATION_MINUTES * 60_000),
    location:
      item.locationLat != null && item.locationLng != null
        ? { lat: item.locationLat, lng: item.locationLng }
        : null,
  };
}

/**
 * Every locked, timed, group item — the raw material for everyone's
 * timelines. Fetched once and reused per member so a trip-wide check doesn't
 * requery per person.
 */
async function lockedGroupItems(access: TripAccess): Promise<Item[]> {
  const items = await listItems(access, { status: "locked" });
  return items.filter((i) => i.visibility === "group" && i.startsAt);
}

/**
 * A single member's attending timeline built from group items only —
 * required items for everyone, optional items only where they RSVP'd yes.
 * Deliberately blind to private items: this is what a planner may compute
 * about *other* people, and it never touches anyone's private data.
 */
export async function groupTimelineFor(
  memberId: string,
  groupItems: Item[],
  rsvps: Map<string, Map<string, string>>,
): Promise<ScheduleItem[]> {
  return groupItems
    .filter((item) => {
      if (item.commitment === "required") return true;
      return rsvps.get(item.id)?.get(memberId) === "yes";
    })
    .map(toScheduleItem);
}

/**
 * The viewer's own full timeline: every group item they're attending, plus
 * their own private locked items. `listItems` already scopes private items to
 * their author, so this is the one place private plans legitimately enter
 * conflict math — and only for the person they belong to.
 */
export async function conflictsForViewer(
  access: TripAccess,
  travelProvider: TravelTimeProvider = new HaversineTravelTimeProvider(),
): Promise<ScheduleFinding[]> {
  const items = await listItems(access, { status: "locked" });
  const timedItems = items.filter((i) => i.startsAt);

  const groupItems = timedItems.filter((i) => i.visibility === "group");
  const rsvps = await rsvpsForItems(groupItems.map((i) => i.id));
  const rsvpMap = new Map(rsvps.map((r) => [r.itemId, r.responses]));

  const attending = timedItems.filter((item) => {
    if (item.visibility === "private") return true; // already scoped to the viewer
    if (item.commitment === "required") return true;
    return rsvpMap.get(item.id)?.get(access.viewer.id) === "yes";
  });

  return analyzeTimeline(attending.map(toScheduleItem), travelProvider);
}

export type LockImpact = {
  member: TripMemberSummary;
  newFindings: ScheduleFinding[];
};

/**
 * What locking `candidate` with `commitment` would do to each affected
 * member's schedule — the check a planner sees before confirming a lock.
 * Only inspects group items, so it can run for every member without
 * exposing anyone's private plans to the planner.
 */
export async function previewLockImpact(
  access: TripAccess,
  candidate: Item,
  commitment: "required" | "optional",
  travelProvider: TravelTimeProvider = new HaversineTravelTimeProvider(),
): Promise<LockImpact[]> {
  if (!candidate.startsAt || candidate.visibility !== "group") return [];

  const existing = await lockedGroupItems(access);
  const rsvps = await rsvpsForItems(existing.map((i) => i.id));
  const rsvpMap = new Map(rsvps.map((r) => [r.itemId, r.responses]));
  const candidateSchedule = toScheduleItem(candidate);

  const affected = access.members.filter(
    (m) => commitment === "required" || rsvpMap.get(candidate.id)?.get(m.userId) === "yes",
  );

  const impacts: LockImpact[] = [];
  for (const member of affected) {
    const before = await groupTimelineFor(member.userId, existing, rsvpMap);
    // Only findings touching the candidate are new — anything else was
    // already true of the member's schedule before this lock.
    const after = await analyzeTimeline([...before, candidateSchedule], travelProvider);
    const newFindings = flagged(after).filter(
      (f) => f.before.id === candidate.id || f.after.id === candidate.id,
    );

    if (newFindings.length > 0) impacts.push({ member, newFindings });
  }

  return impacts;
}
