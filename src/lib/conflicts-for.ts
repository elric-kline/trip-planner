import type { Coordinates, TravelTimeProvider } from "./travel.ts";
import { HaversineTravelTimeProvider } from "./travel.ts";
import { analyzeTimeline, DEFAULT_DURATION_MINUTES, flagged, type ScheduleFinding, type ScheduleItem } from "./conflicts.ts";
import { rsvpsForItems } from "./attendance.ts";
import { listItems, type Item, type TripAccess, type TripMemberSummary } from "./scope.ts";
import { getTransportDetailsForItems, getTransportLegsForItems, type TransportLeg } from "./transport.ts";
import { transportBufferFor, widenForBuffer } from "./transport-buffer.ts";
import { effectiveLegTimes, NoopFlightStatusProvider, type FlightStatusProvider } from "./flight-status.ts";

/**
 * A transport item's buffer-widened, live-status-aware window -- what
 * toScheduleItem uses in place of the item's raw startsAt/endsAt when one
 * is available. destinationLocation is where a flight actually lands (the
 * last leg's geocoded arrival, if resolved) -- null for any other subtype,
 * or a flight with no resolvable arrival, deliberately not falling back to
 * the item's own `location` (its departure point); see conflicts.ts's
 * ScheduleItem.destinationLocation for why that fallback would be wrong.
 */
type TransportWindow = { startsAt: Date; endsAt: Date; destinationLocation: Coordinates | null };

function utcCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lookupLegStatus(provider: FlightStatusProvider, leg: TransportLeg) {
  // A leg without a flight number (not yet filled in) has nothing to look up.
  if (!leg.flightNumber) return Promise.resolve(null);
  return provider.lookup({ flightNumber: leg.flightNumber, departureDate: utcCalendarDate(leg.departsAt) });
}

/**
 * Every transport item's effective conflict-analysis window: its own
 * schedule (or, for a flight, the first leg's departure and last leg's
 * arrival -- live-resolved if flightStatusProvider has an update) widened
 * by its subtype's buffer (see transport-buffer.ts's transportBufferFor).
 *
 * Fetched once per caller and keyed by item id specifically so a loop that
 * calls groupTimelineFor per member (see previewLockImpact) doesn't repeat
 * the same DB/live-status lookups once per member -- the "moving target"
 * of a live flight delay is looked up once, then reused for everyone whose
 * timeline it affects.
 */
async function transportWindows(
  items: Item[],
  flightStatusProvider: FlightStatusProvider,
): Promise<Map<string, TransportWindow>> {
  const transportItems = items.filter((i) => i.category === "transport" && i.startsAt && i.endsAt);
  if (transportItems.length === 0) return new Map();

  const detailsMap = await getTransportDetailsForItems(transportItems.map((i) => i.id));
  const flightItemIds = transportItems
    .filter((i) => detailsMap.get(i.id)?.subtype === "flight")
    .map((i) => i.id);
  const legsMap = await getTransportLegsForItems(flightItemIds);

  const windows = new Map<string, TransportWindow>();
  await Promise.all(
    transportItems.map(async (item) => {
      const details = detailsMap.get(item.id);
      if (!details) return; // no details saved yet -- nothing to widen, item.startsAt/endsAt stands as-is

      let scheduled = { departsAt: item.startsAt!, arrivesAt: item.endsAt! };
      let destinationLocation: Coordinates | null = null;
      const legs = legsMap.get(item.id);
      if (details.subtype === "flight" && legs && legs.length > 0) {
        const firstLeg = legs[0];
        const lastLeg = legs[legs.length - 1];
        const [firstStatus, lastStatus] = await Promise.all([
          lookupLegStatus(flightStatusProvider, firstLeg),
          lookupLegStatus(flightStatusProvider, lastLeg),
        ]);
        scheduled = {
          departsAt: effectiveLegTimes(firstLeg, firstStatus).departsAt,
          arrivesAt: effectiveLegTimes(lastLeg, lastStatus).arrivesAt,
        };
        destinationLocation =
          lastLeg.arrivalLat != null && lastLeg.arrivalLng != null
            ? { lat: lastLeg.arrivalLat, lng: lastLeg.arrivalLng }
            : null;
      } else if (details.destinationLat != null && details.destinationLng != null) {
        // Non-flight subtypes have no legs -- transportDetails.destinationLat/Lng
        // (a drive/rideshare/train's own endpoint, distinct from the item's
        // own `location` -- its departure point) is the only source.
        destinationLocation = { lat: details.destinationLat, lng: details.destinationLng };
      }

      const buffer = transportBufferFor(details.subtype, details.international);
      windows.set(item.id, {
        ...widenForBuffer({ startsAt: scheduled.departsAt, endsAt: scheduled.arrivesAt }, buffer),
        destinationLocation,
      });
    }),
  );
  return windows;
}

function toScheduleItem(item: Item, windows: Map<string, TransportWindow>): ScheduleItem {
  const window = windows.get(item.id);
  const location =
    item.locationLat != null && item.locationLng != null
      ? { lat: item.locationLat, lng: item.locationLng }
      : null;
  return {
    id: item.id,
    title: item.title,
    startsAt: window?.startsAt ?? item.startsAt!,
    endsAt:
      window?.endsAt ??
      item.endsAt ??
      new Date(item.startsAt!.getTime() + DEFAULT_DURATION_MINUTES * 60_000),
    location,
    // A transport item (window present) never falls back to its own
    // `location` here -- that's the departure point, and reusing it for
    // where this item *ends up* is exactly the cross-country false
    // conflict this type exists to prevent. Anything else (window absent:
    // not a transport item, or a transport item with no details saved
    // yet) is stationary, same as before transport destinations existed.
    destinationLocation: window ? window.destinationLocation : location,
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
 *
 * `windows` is optional so existing callers that never touch transport
 * items keep working unchanged -- an empty map just means every item falls
 * back to its own startsAt/endsAt, same as before transport buffers existed.
 */
export async function groupTimelineFor(
  memberId: string,
  groupItems: Item[],
  rsvps: Map<string, Map<string, string>>,
  windows: Map<string, TransportWindow> = new Map(),
): Promise<ScheduleItem[]> {
  return groupItems
    .filter((item) => {
      if (item.commitment === "required") return true;
      return rsvps.get(item.id)?.get(memberId) === "yes";
    })
    .map((item) => toScheduleItem(item, windows));
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
  flightStatusProvider: FlightStatusProvider = new NoopFlightStatusProvider(),
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

  const windows = await transportWindows(attending, flightStatusProvider);
  return analyzeTimeline(attending.map((item) => toScheduleItem(item, windows)), travelProvider);
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
  flightStatusProvider: FlightStatusProvider = new NoopFlightStatusProvider(),
): Promise<LockImpact[]> {
  if (!candidate.startsAt || candidate.visibility !== "group") return [];

  const existing = await lockedGroupItems(access);
  const rsvps = await rsvpsForItems(existing.map((i) => i.id));
  const rsvpMap = new Map(rsvps.map((r) => [r.itemId, r.responses]));

  // Computed once, up front -- every affected member's groupTimelineFor call
  // below reuses it rather than re-fetching transport details/live status
  // per member for the same handful of transport items.
  const windows = await transportWindows([...existing, candidate], flightStatusProvider);
  const candidateSchedule = toScheduleItem(candidate, windows);

  const affected = access.members.filter(
    (m) => commitment === "required" || rsvpMap.get(candidate.id)?.get(m.userId) === "yes",
  );

  const impacts: LockImpact[] = [];
  for (const member of affected) {
    const before = await groupTimelineFor(member.userId, existing, rsvpMap, windows);
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
