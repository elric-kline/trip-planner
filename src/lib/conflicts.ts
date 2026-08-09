import type { Coordinates, TravelMode, TravelTimeProvider } from "./travel.ts";
import { HaversineTravelTimeProvider, inferMode } from "./travel.ts";

export type Severity = "ok" | "tight" | "conflict";

export type ScheduleItem = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** Where the traveler is for this item's *start* -- what an item before this one needs to reach. */
  location: Coordinates | null;
  /**
   * Where the traveler ends up once this item is *done* -- what governs
   * travel to whatever comes next. For a stationary item (dining, lodging,
   * an activity) that's the same point as `location`, since you're there
   * the whole time. A directional item (a flight, in particular) sets this
   * independently: where you land has nothing to do with where you took
   * off, and reusing `location` for both would silently estimate a ground
   * route between the two -- see conflicts-for.ts's toScheduleItem, which
   * leaves this null rather than guessing when the actual destination
   * isn't known, so the gap reads as unanalyzable instead of wrong.
   */
  destinationLocation: Coordinates | null;
  /**
   * Whether this item is a lodging stay -- staying somewhere isn't a
   * single-use slot the way a dinner reservation or a museum visit is, so
   * analyzeTimeline treats it differently: it doesn't occupy the traveler
   * for its whole span the way everything else does, only near its own
   * edges (see LODGING_ARRIVAL_BUFFER_MINUTES/LODGING_DEPARTURE_BUFFER_MINUTES
   * below) plus a hard exclusion against any *other* lodging. Unset/false
   * for every other category, which keeps the ordinary overlap rules.
   */
  isLodging?: boolean;
};

export type ScheduleFinding = {
  severity: Severity;
  before: ScheduleItem;
  after: ScheduleItem;
  reason: "overlap" | "travel" | "no-location";
  gapMinutes: number;
  travelMinutes: number;
  overheadMinutes: number;
  /** gap − travel − overhead. Negative means the two items collide. */
  slackMinutes: number;
  mode: TravelMode | null;
};

/** Items with no end time are assumed to occupy this long, e.g. a meal or a museum stop. */
export const DEFAULT_DURATION_MINUTES = 60;

/**
 * The time an item actually occupies, with the default duration standing in
 * for a missing end. Exported because "do these two collide?" is asked
 * outside timeline analysis too -- see items.ts, where locking something as
 * required voids the RSVPs on whatever it displaces.
 */
export function occupiedWindow(item: { startsAt: Date; endsAt: Date | null }): { start: number; end: number } {
  const start = item.startsAt.getTime();
  return { start, end: (item.endsAt ?? new Date(start + DEFAULT_DURATION_MINUTES * 60_000)).getTime() };
}

/**
 * Half-open overlap: two items that merely touch (one ends exactly as the
 * next begins) don't collide, which is the same boundary analyzeTimeline
 * uses when it treats a zero gap as tight rather than as a conflict.
 */
export function windowsOverlap(
  a: { startsAt: Date; endsAt: Date | null },
  b: { startsAt: Date; endsAt: Date | null },
): boolean {
  const wa = occupiedWindow(a);
  const wb = occupiedWindow(b);
  return wa.start < wb.end && wb.start < wa.end;
}

/**
 * How long check-in itself takes once you actually arrive -- the property
 * being ready to have you isn't the same as you being checked in, bags
 * stashed, and free to go do something else. Widens forward from a lodging
 * item's own startsAt only; nothing before arrival needs padding here, since
 * whatever's still travel time to *reach* the property is already covered by
 * the ordinary travel-time check between it and whatever came before.
 */
export const LODGING_ARRIVAL_BUFFER_MINUTES = 60;
/**
 * How long check-out itself takes -- packing, gathering everyone, actually
 * getting out the door. Widens backward from a lodging item's own endsAt
 * only, the mirror of the arrival buffer above.
 */
export const LODGING_DEPARTURE_BUFFER_MINUTES = 60;

/**
 * Whether two items can't both hold the same time -- the general-purpose
 * "do these clash" check used outside full timeline analysis (voiding RSVPs
 * a new required lock displaces -- see items.ts's voidRsvpsDisplacedBy --
 * and warning about undecided blind spots before one -- see
 * conflicts-for.ts's previewLockImpact). Ordinary items still use plain
 * windowsOverlap.
 *
 * Lodging is different: staying somewhere for two days isn't a single-use
 * slot the way a two-hour dinner reservation is, so it only clashes with
 * (a) another lodging item -- nobody's staying two places overnight -- or
 * (b) something landing inside its own arrival/departure buffer, where
 * check-in/check-out itself is what's actually using the time. The rest of
 * a stay coexists freely with everything else, which is the entire point of
 * staying somewhere -- locking a two-day hotel booking shouldn't void every
 * dinner reservation and activity RSVP'd during it.
 */
export function itemsConflict(
  a: { startsAt: Date; endsAt: Date | null; category?: string | null },
  b: { startsAt: Date; endsAt: Date | null; category?: string | null },
): boolean {
  const aLodging = a.category === "lodging";
  const bLodging = b.category === "lodging";
  if (aLodging && bLodging) return windowsOverlap(a, b);
  if (aLodging) return lodgingBufferOverlap(a, b);
  if (bLodging) return lodgingBufferOverlap(b, a);
  return windowsOverlap(a, b);
}

function lodgingBufferOverlap(
  lodging: { startsAt: Date; endsAt: Date | null },
  other: { startsAt: Date; endsAt: Date | null },
): boolean {
  const arrival = {
    startsAt: lodging.startsAt,
    endsAt: new Date(lodging.startsAt.getTime() + LODGING_ARRIVAL_BUFFER_MINUTES * 60_000),
  };
  if (windowsOverlap(arrival, other)) return true;
  if (!lodging.endsAt) return false;
  const departure = {
    startsAt: new Date(lodging.endsAt.getTime() - LODGING_DEPARTURE_BUFFER_MINUTES * 60_000),
    endsAt: lodging.endsAt,
  };
  return windowsOverlap(departure, other);
}

/**
 * Splits one lodging ScheduleItem into the two short, edge-anchored events
 * that actually participate in analyzeTimeline's sequential/travel-time
 * pass -- see that function's own doc comment for why the item itself is
 * never fed in whole. Both keep the real item's id (and location), so a
 * finding involving either one still links back to the actual lodging item
 * everywhere the UI keys off ScheduleFinding.before/after.id.
 *
 * Clamped so a very short stay's two buffers can't extend past each other
 * out beyond the stay's own real boundaries -- the whole thing is
 * legitimately "just logistics" at that point, not an error.
 */
function lodgingBufferEvents(item: ScheduleItem): [ScheduleItem, ScheduleItem] {
  const arrivalEnd = new Date(
    Math.min(item.startsAt.getTime() + LODGING_ARRIVAL_BUFFER_MINUTES * 60_000, item.endsAt.getTime()),
  );
  const departureStart = new Date(
    Math.max(item.endsAt.getTime() - LODGING_DEPARTURE_BUFFER_MINUTES * 60_000, item.startsAt.getTime()),
  );
  return [
    { ...item, title: `${item.title} (check-in)`, startsAt: item.startsAt, endsAt: arrivalEnd },
    { ...item, title: `${item.title} (check-out)`, startsAt: departureStart, endsAt: item.endsAt },
  ];
}

/** Below this the gap counts as "tight at best" even though it isn't negative. */
function tightThresholdMinutes(travelMinutes: number): number {
  return Math.max(10, travelMinutes * 0.25);
}

function severityFor(slackMinutes: number, travelMinutes: number): Severity {
  if (slackMinutes < 0) return "conflict";
  if (slackMinutes < tightThresholdMinutes(travelMinutes)) return "tight";
  return "ok";
}

/**
 * Every overlapping pair among the timeline's lodging items -- nobody's
 * staying two places overnight, so this is a hard conflict regardless of
 * travel time, same posture as two ordinary items' raw overlap. A separate
 * pass rather than something the sequential loop below finds on its own:
 * lodging items don't feed that loop as themselves at all (see
 * lodgingBufferEvents), precisely so a two-day stay doesn't collide with
 * everything scheduled inside it -- which means two overlapping *stays*
 * need their own explicit check to still be caught.
 */
function lodgingOverlapFindings(timeline: ScheduleItem[]): ScheduleFinding[] {
  const lodging = timeline.filter((i) => i.isLodging);
  const findings: ScheduleFinding[] = [];
  for (let i = 0; i < lodging.length; i++) {
    for (let j = i + 1; j < lodging.length; j++) {
      const [before, after] =
        lodging[i].startsAt.getTime() <= lodging[j].startsAt.getTime() ? [lodging[i], lodging[j]] : [lodging[j], lodging[i]];
      if (!windowsOverlap(before, after)) continue;
      const gapMinutes = (after.startsAt.getTime() - before.endsAt.getTime()) / 60_000;
      findings.push({
        severity: "conflict",
        before,
        after,
        reason: "overlap",
        gapMinutes,
        travelMinutes: 0,
        overheadMinutes: 0,
        slackMinutes: gapMinutes,
        mode: null,
      });
    }
  }
  return findings;
}

/**
 * The core of conflict detection: given one person's timeline (already
 * resolved to exactly what they're attending — see conflicts-for.ts), find
 * every adjacent pair that overlaps or leaves too little slack to travel
 * between them.
 *
 * A lodging item never enters that adjacent-pair pass as itself -- staying
 * somewhere for two days isn't a single continuously-occupying event the
 * way everything else on a timeline is, so treating it like one made a
 * two-day stay "overlap" with whatever happened to be the very next thing
 * chronologically, and voidRsvpsDisplacedBy's separate all-pairs check (see
 * items.ts) made locking it clear out RSVPs for everything nested inside
 * it. Instead each lodging item is split into two short, edge-anchored
 * events -- arrival (check-in) and departure (check-out), see
 * lodgingBufferEvents -- so only genuine crunches near those edges surface
 * through the ordinary travel-time machinery below, and the vast middle of
 * a stay is free to coexist with dinners, activities, whatever. Lodging vs.
 * lodging is still a hard conflict, just found separately (see
 * lodgingOverlapFindings) since two overlapping stays' buffer events won't
 * generally touch each other the way the stays themselves do.
 *
 * Pure and deterministic on purpose — do not let an LLM compute this part.
 * It should narrate the result, not produce it.
 */
export async function analyzeTimeline(
  timeline: ScheduleItem[],
  travelProvider: TravelTimeProvider = new HaversineTravelTimeProvider(),
): Promise<ScheduleFinding[]> {
  const sequential = timeline.flatMap((item) => (item.isLodging ? lodgingBufferEvents(item) : [item]));
  const sorted = [...sequential].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const findings: ScheduleFinding[] = lodgingOverlapFindings(timeline);

  for (let i = 0; i < sorted.length - 1; i++) {
    const before = sorted[i];
    const after = sorted[i + 1];
    const gapMinutes = (after.startsAt.getTime() - before.endsAt.getTime()) / 60_000;

    if (gapMinutes < 0) {
      findings.push({
        severity: "conflict",
        before,
        after,
        reason: "overlap",
        gapMinutes,
        travelMinutes: 0,
        overheadMinutes: 0,
        slackMinutes: gapMinutes,
        mode: null,
      });
      continue;
    }

    if (!before.destinationLocation || !after.location) {
      // Nothing to say about travel without both locations — not flagged as
      // an issue, just not analyzable. Deliberately before.destinationLocation,
      // not before.location: for a directional item those can differ, and
      // "we don't know where this one ends up" must stay unanalyzable rather
      // than silently falling back to where it started.
      findings.push({
        severity: "ok",
        before,
        after,
        reason: "no-location",
        gapMinutes,
        travelMinutes: 0,
        overheadMinutes: 0,
        slackMinutes: gapMinutes,
        mode: null,
      });
      continue;
    }

    const mode = inferMode(before.destinationLocation, after.location);
    const est = await travelProvider.estimate(before.destinationLocation, after.location, mode);
    const slackMinutes = gapMinutes - est.minutes - est.overheadMinutes;

    findings.push({
      severity: severityFor(slackMinutes, est.minutes),
      before,
      after,
      reason: "travel",
      gapMinutes,
      travelMinutes: est.minutes,
      overheadMinutes: est.overheadMinutes,
      slackMinutes,
      mode,
    });
  }

  return findings;
}

export const flagged = (findings: ScheduleFinding[]) =>
  findings.filter((f) => f.severity !== "ok");
