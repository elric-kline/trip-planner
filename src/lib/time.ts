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
