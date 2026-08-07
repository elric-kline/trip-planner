/**
 * `<input type="datetime-local">` submits a bare "2026-10-11T10:00" with no
 * timezone of its own. Parsing that with `new Date(str)` interprets it in
 * whatever timezone the *server process* happens to run in — not the trip's
 * destination, and not the browser's either. On a UTC container that silently
 * shifts every itinerary time by the destination's offset from UTC.
 *
 * These two functions are the only correct way to move between that string
 * and a UTC instant: they always go through the destination's IANA zone,
 * regardless of what timezone the process itself is running in.
 */

/** Minutes such that localWallClock = utcInstant + offset, in `timeZone`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Interprets a `datetime-local` value as wall-clock time in `timeZone` and
 * returns the corresponding UTC instant. One correction pass — accurate
 * except for the ambiguous or skipped hour right at a DST transition, which
 * no single-pass approach resolves without picking a convention.
 */
export function zonedInputToUtc(localValue: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue.trim());
  if (!m) return null;

  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const naiveUtcMs = Date.UTC(y, mo - 1, d, h, mi);
  const offset = tzOffsetMinutes(new Date(naiveUtcMs), timeZone);
  return new Date(naiveUtcMs - offset * 60_000);
}

/** Inverse of {@link zonedInputToUtc}: an instant, rendered as a `datetime-local` value in `timeZone`. */
export function utcToZonedInputValue(instant: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Which calendar date (`YYYY-MM-DD`) an instant falls on, read in
 * `timeZone` -- e.g. "does this item's new startsAt land on one of the
 * trip's own days?" (see items.ts's placeInDay). Just the date half of
 * {@link utcToZonedInputValue}; a separate name because callers reaching
 * for a bare date, not a datetime-local value, shouldn't have to know that.
 */
export function calendarDateInZone(instant: Date, timeZone: string): string {
  return utcToZonedInputValue(instant, timeZone).slice(0, 10);
}

const MONTH_ABBREV = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A trip's start/end are plain `YYYY-MM-DD` calendar dates — no timezone, no
 * instant. Parsed by hand rather than via `new Date(...)` so a rendering
 * environment's own timezone can never shift the calendar day, same
 * reasoning as the datetime-local helpers above.
 */
function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${value}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Every `YYYY-MM-DD` from `startDate` to `endDate`, inclusive. Used to seed
 * one trip_days row per calendar date (see lib/days.ts's seedDays) — walked
 * via `Date.UTC` day-by-day rather than any zoned arithmetic, since a plain
 * calendar date has no timezone of its own to begin with (same reasoning as
 * parseCalendarDate below): there's no DST to cross when nothing is anchored
 * to a zone.
 */
export function eachCalendarDate(startDate: string, endDate: string): string[] {
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  if (endMs < startMs) throw new Error("endDate can't come before startDate.");

  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${mo}-${day}`);
  }
  return dates;
}

/** A single `YYYY-MM-DD` the way a person would say it: `Wed, Sep 2`. Same UTC-anchored-midnight trick as eachCalendarDate to keep the weekday calculation from drifting with the rendering environment's own zone. */
export function formatCalendarDate(date: string): string {
  const { year, month, day } = parseCalendarDate(date);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * Renders a trip's date span the way a person would say it, not the way a
 * database stores it: `2026, Sep 5-12`, `2026, Oct 28 - Nov 11`, or, across
 * a year boundary, `2026-27, Dec 26 - Jan 3`.
 */
export function formatTripDateRange(startDate: string, endDate: string): string {
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);

  const yearLabel =
    start.year === end.year ? `${start.year}` : `${start.year}-${String(end.year).slice(-2)}`;

  const startMonth = MONTH_ABBREV[start.month - 1];

  if (start.year === end.year && start.month === end.month) {
    const days = start.day === end.day ? `${start.day}` : `${start.day}-${end.day}`;
    return `${yearLabel}, ${startMonth} ${days}`;
  }

  const endMonth = MONTH_ABBREV[end.month - 1];
  return `${yearLabel}, ${startMonth} ${start.day} - ${endMonth} ${end.day}`;
}
