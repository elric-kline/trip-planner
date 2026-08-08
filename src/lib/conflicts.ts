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
 * The core of conflict detection: given one person's timeline (already
 * resolved to exactly what they're attending — see conflicts-for.ts), find
 * every adjacent pair that overlaps or leaves too little slack to travel
 * between them.
 *
 * Pure and deterministic on purpose — do not let an LLM compute this part.
 * It should narrate the result, not produce it.
 */
export async function analyzeTimeline(
  timeline: ScheduleItem[],
  travelProvider: TravelTimeProvider = new HaversineTravelTimeProvider(),
): Promise<ScheduleFinding[]> {
  const sorted = [...timeline].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const findings: ScheduleFinding[] = [];

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
