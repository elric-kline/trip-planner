import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePhase, localDate } from "./phase.ts";

test("derivePhase: planning before the start date, active during, completed after", () => {
  const trip = { startDate: "2026-06-01", endDate: "2026-06-05", timezone: "UTC" };

  assert.equal(derivePhase(trip, new Date("2026-05-30T12:00:00Z")), "planning");
  assert.equal(derivePhase(trip, new Date("2026-06-03T12:00:00Z")), "active");
  assert.equal(derivePhase(trip, new Date("2026-06-10T12:00:00Z")), "completed");
});

test("derivePhase: a manual override always wins over the calendar", () => {
  const trip = {
    startDate: "2026-06-01",
    endDate: "2026-06-05",
    timezone: "UTC",
    phaseOverride: "completed" as const,
  };
  assert.equal(derivePhase(trip, new Date("2026-06-03T12:00:00Z")), "completed");
});

test("derivePhase compares dates in the destination's own zone, not the caller's", () => {
  const trip = { startDate: "2026-06-05", endDate: "2026-06-05", timezone: "Pacific/Kiritimati" }; // UTC+14
  // Already June 5th in Kiritimati, but still June 4th UTC.
  const stillJune4Utc = new Date("2026-06-04T20:00:00Z");
  assert.equal(derivePhase(trip, stillJune4Utc), "active");
});

test("localDate formats as YYYY-MM-DD in the given zone", () => {
  assert.equal(localDate(new Date("2026-01-15T23:30:00Z"), "UTC"), "2026-01-15");
  assert.equal(localDate(new Date("2026-01-15T23:30:00Z"), "Pacific/Kiritimati"), "2026-01-16");
});
