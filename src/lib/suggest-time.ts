import { DEFAULT_DURATION_MINUTES } from "./conflicts.ts";
import { utcToZonedInputValue } from "./time.ts";

/** Just enough of an item to reason about when it occupies -- see suggestStartTime. */
export type TimedInterval = { startsAt: Date; endsAt: Date | null };

const NOON_MINUTES = 12 * 60;
const MORNING_DEFAULT_MINUTES = 9 * 60;
/** How much breathing room to leave after the last locked thing ends, rather than butting the suggestion right up against it. */
const GAP_AFTER_LAST_MINUTES = 30;
/** A suggestion never rolls past this into "basically tomorrow" -- see suggestStartTime's third case. */
const LATEST_SUGGESTABLE_MINUTES = 23 * 60;

function minutesOfDay(instant: Date, timeZone: string): number {
  const hhmm = utcToZonedInputValue(instant, timeZone).slice(11);
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * A reasonable "Starts" time to pre-fill for a new item on a given day, in
 * `timeZone`'s own wall clock -- what AddItemForm shows before anyone's
 * touched the field. Three cases, in the order a planner would actually
 * reason about the day:
 *
 * - Nothing locked yet: no evidence either way, so noon is as good a guess
 *   as any -- neither an early-riser's assumption nor a late one.
 * - Something's already locked by midday: assume the new thing comes after
 *   whatever's already booked (e.g. a day booked through 3pm suggests
 *   something starting a bit after 3, not squeezed in earlier), not on top
 *   of it.
 * - Everything locked so far starts in the afternoon: the morning is free,
 *   so suggest an ordinary morning start instead of stacking onto the
 *   afternoon's plans.
 *
 * Deliberately only looks at *locked* items -- an idea or proposal isn't a
 * real commitment yet (the same distinction conflicts.ts's timeline
 * analysis draws), so it shouldn't steer where a brand new one lands. Also
 * deliberately blind to lodging: a multi-day stay doesn't occupy a single
 * day the way an activity does (see conflicts.ts's own treatment of
 * lodging), so including it here would read "days entirely booked" for a
 * day that's actually wide open. Callers filter both of those out before
 * calling in (see DayItemBuilder.tsx).
 */
export function suggestStartTime(locked: TimedInterval[], timeZone: string): string {
  if (locked.length === 0) return minutesToHHMM(NOON_MINUTES);

  const starts = locked.map((i) => minutesOfDay(i.startsAt, timeZone));
  const ends = locked.map((i) =>
    minutesOfDay(i.endsAt ?? new Date(i.startsAt.getTime() + DEFAULT_DURATION_MINUTES * 60_000), timeZone),
  );

  const earliestStart = Math.min(...starts);
  if (earliestStart > NOON_MINUTES) {
    // Nothing booked all morning -- an ordinary morning start is free.
    return minutesToHHMM(MORNING_DEFAULT_MINUTES);
  }

  // Already into the day by noon -- assume the new thing slots in after
  // whatever's already locked, not on top of it.
  const latestEnd = Math.max(...ends);
  return minutesToHHMM(Math.min(latestEnd + GAP_AFTER_LAST_MINUTES, LATEST_SUGGESTABLE_MINUTES));
}
