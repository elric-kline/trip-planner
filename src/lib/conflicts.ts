import type { Coordinates, TravelMode, TravelTimeProvider } from "./travel.ts";
import { HaversineTravelTimeProvider, inferMode } from "./travel.ts";

export type Severity = "ok" | "tight" | "conflict";

export type ScheduleItem = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: Coordinates | null;
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

    if (!before.location || !after.location) {
      // Nothing to say about travel without both locations — not flagged as
      // an issue, just not analyzable.
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

    const mode = inferMode(before.location, after.location);
    const est = await travelProvider.estimate(before.location, after.location, mode);
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
