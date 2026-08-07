import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDateInZone,
  eachCalendarDate,
  formatCalendarDate,
  formatTripDateRange,
  utcToZonedInputValue,
  zonedInputToUtc,
} from "./time.ts";

test("a wall-clock time in a zone behind UTC converts to the later UTC instant", () => {
  // 10:00 in Mexico City (UTC-6, no DST) is 16:00 UTC the same day.
  const utc = zonedInputToUtc("2026-10-11T10:00", "America/Mexico_City");
  assert.equal(utc?.toISOString(), "2026-10-11T16:00:00.000Z");
});

test("a wall-clock time in a zone ahead of UTC converts to the earlier UTC instant", () => {
  // 10:00 in Tokyo (UTC+9) is 01:00 UTC the same day.
  const utc = zonedInputToUtc("2026-10-11T10:00", "Asia/Tokyo");
  assert.equal(utc?.toISOString(), "2026-10-11T01:00:00.000Z");
});

test("rejects a malformed input instead of guessing", () => {
  assert.equal(zonedInputToUtc("not-a-date", "UTC"), null);
});

test("round-trips through both directions", () => {
  const zone = "America/Los_Angeles";
  const input = "2026-07-04T14:30";
  const utc = zonedInputToUtc(input, zone)!;
  assert.equal(utcToZonedInputValue(utc, zone), input);
});

test("crossing a DST boundary still lands on the correct UTC instant", () => {
  // America/Los_Angeles: PDT (UTC-7) starts 2026-03-08. Pick one day on each side.
  const before = zonedInputToUtc("2026-03-01T09:00", "America/Los_Angeles")!; // PST, UTC-8
  const after = zonedInputToUtc("2026-03-15T09:00", "America/Los_Angeles")!; // PDT, UTC-7

  assert.equal(before.getUTCHours(), 17); // 09:00 + 8h
  assert.equal(after.getUTCHours(), 16); // 09:00 + 7h
});

test("the destination's own clock reads back the original wall time", () => {
  const zone = "Australia/Sydney";
  const utc = zonedInputToUtc("2026-12-25T18:00", zone)!;
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(utc);
  assert.equal(formatted, "18:00");
});

test("a same-month range collapses to one month name and a tight day dash", () => {
  assert.equal(formatTripDateRange("2026-09-05", "2026-09-12"), "2026, Sep 5-12");
});

test("a cross-month range within a year spells out both months", () => {
  assert.equal(formatTripDateRange("2026-10-28", "2026-11-11"), "2026, Oct 28 - Nov 11");
});

test("a range crossing a year boundary shows both years, abbreviated", () => {
  assert.equal(formatTripDateRange("2026-12-26", "2027-01-03"), "2026-27, Dec 26 - Jan 3");
});

test("a single-day trip shows one date, no dash", () => {
  assert.equal(formatTripDateRange("2026-09-05", "2026-09-05"), "2026, Sep 5");
});

test("rejects a date that isn't YYYY-MM-DD", () => {
  assert.throws(() => formatTripDateRange("09/05/2026", "2026-09-12"));
});

test("eachCalendarDate walks every date inclusive of both ends", () => {
  assert.deepEqual(eachCalendarDate("2026-09-05", "2026-09-08"), [
    "2026-09-05",
    "2026-09-06",
    "2026-09-07",
    "2026-09-08",
  ]);
});

test("eachCalendarDate handles a single-day trip and a month boundary", () => {
  assert.deepEqual(eachCalendarDate("2026-09-05", "2026-09-05"), ["2026-09-05"]);
  assert.deepEqual(eachCalendarDate("2026-01-30", "2026-02-02"), [
    "2026-01-30",
    "2026-01-31",
    "2026-02-01",
    "2026-02-02",
  ]);
});

test("eachCalendarDate rejects an end date before the start date", () => {
  assert.throws(() => eachCalendarDate("2026-09-08", "2026-09-05"));
});

test("formatCalendarDate reads 'Wed, Sep 2', the weekday computed without any local-zone drift", () => {
  assert.equal(formatCalendarDate("2026-09-02"), "Wed, Sep 2");
});

test("calendarDateInZone reads the date the destination's own clock would show, not UTC's", () => {
  // 01:00 UTC on the 12th is still 18:00 on the 11th in Los Angeles (UTC-7 in July).
  const instant = new Date("2026-07-12T01:00:00Z");
  assert.equal(calendarDateInZone(instant, "America/Los_Angeles"), "2026-07-11");
  assert.equal(calendarDateInZone(instant, "UTC"), "2026-07-12");
});
