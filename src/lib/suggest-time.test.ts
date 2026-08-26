import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestStartTime, type TimedInterval } from "./suggest-time.ts";

const ZONE = "UTC"; // keeps expected wall-clock hours equal to the UTC hours used to build fixtures

function interval(startsAt: string, endsAt: string | null): TimedInterval {
  return { startsAt: new Date(startsAt), endsAt: endsAt ? new Date(endsAt) : null };
}

test("no locked items: noon, no other evidence to go on", () => {
  assert.equal(suggestStartTime([], ZONE), "12:00");
});

test("booked through 3pm: suggests shortly after the last thing ends, not squeezed in earlier", () => {
  const locked = [
    interval("2026-06-01T09:00:00Z", "2026-06-01T10:00:00Z"),
    interval("2026-06-01T13:00:00Z", "2026-06-01T15:00:00Z"),
  ];
  assert.equal(suggestStartTime(locked, ZONE), "15:30");
});

test("booked in the afternoon but not the morning: suggests an ordinary morning start instead", () => {
  const locked = [interval("2026-06-01T14:00:00Z", "2026-06-01T16:00:00Z")];
  assert.equal(suggestStartTime(locked, ZONE), "09:00");
});

test("a locked item with no end assumes the default duration when checking how late the day already runs", () => {
  // Starts at 11:00, no end -- occupies until 12:00 by the same default
  // duration convention as conflicts.ts's occupiedWindow. That's before
  // noon, so this still counts as "already into the day by noon."
  const locked = [interval("2026-06-01T11:00:00Z", null)];
  assert.equal(suggestStartTime(locked, ZONE), "12:30");
});

test("a suggestion never rolls past 23:00, even after a very late booked block", () => {
  const locked = [interval("2026-06-01T09:00:00Z", "2026-06-01T22:50:00Z")];
  assert.equal(suggestStartTime(locked, ZONE), "23:00");
});

test("only the earliest start and latest end matter -- a gap in the middle of the day doesn't change the guess", () => {
  const locked = [
    interval("2026-06-01T09:00:00Z", "2026-06-01T10:00:00Z"),
    interval("2026-06-01T14:00:00Z", "2026-06-01T15:00:00Z"),
  ];
  assert.equal(suggestStartTime(locked, ZONE), "15:30");
});

test("reads times in the given timezone, not the instant's own UTC clock", () => {
  // 14:00-15:00 UTC is 07:00-08:00 in America/Los_Angeles (PDT, UTC-7 in
  // June) -- before noon there, so this reads as "already into the day,"
  // suggesting shortly after 08:00. Read naively as UTC clock hours
  // instead, 14:00 looks like an afternoon-only day and would wrongly
  // suggest a flat 09:00 morning slot.
  const locked = [interval("2026-06-01T14:00:00Z", "2026-06-01T15:00:00Z")];
  assert.equal(suggestStartTime(locked, "America/Los_Angeles"), "08:30");
});
