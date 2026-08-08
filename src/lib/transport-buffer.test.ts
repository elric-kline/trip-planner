import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeLegLayovers,
  deriveScheduleFromLegs,
  transportBufferFor,
  MIN_CONNECTION_MINUTES,
  MIN_INTERNATIONAL_CONNECTION_MINUTES,
  type LegTiming,
} from "./transport-buffer.ts";

// Only departsAt/arrivesAt matter to this logic -- a real TransportLeg row
// (with id, itemId, airline, etc.) satisfies LegTiming structurally, with
// no need for this pure module to depend on the DB row shape.
function leg(departsAt: string, arrivesAt: string): LegTiming {
  return { departsAt: new Date(departsAt), arrivesAt: new Date(arrivesAt) };
}

test("transportBufferFor: each subtype gets its own pre/post padding", () => {
  assert.deepEqual(transportBufferFor("flight"), { preMinutes: 90, postMinutes: 30 });
  assert.deepEqual(transportBufferFor("flight", true), { preMinutes: 150, postMinutes: 45 });
  assert.deepEqual(transportBufferFor("train"), { preMinutes: 15, postMinutes: 5 });
  assert.deepEqual(transportBufferFor("drive"), { preMinutes: 0, postMinutes: 10 });
  assert.deepEqual(transportBufferFor("rideshare"), { preMinutes: 10, postMinutes: 0 });
  assert.deepEqual(transportBufferFor("other"), { preMinutes: 15, postMinutes: 15 });
});

test("transportBufferFor: international only changes the answer for flight", () => {
  assert.deepEqual(transportBufferFor("train", true), transportBufferFor("train", false));
  assert.notDeepEqual(transportBufferFor("flight", true), transportBufferFor("flight", false));
});

test("analyzeLegLayovers: flags a connection shorter than the minimum, leaves a comfortable one alone", () => {
  const legs = [
    leg("2026-08-10T08:00:00Z", "2026-08-10T09:30:00Z"),
    // 30 minute layover -- under the 45 minute domestic minimum.
    leg("2026-08-10T10:00:00Z", "2026-08-10T12:00:00Z"),
    // 90 minute layover -- comfortably over.
    leg("2026-08-10T13:30:00Z", "2026-08-10T16:00:00Z"),
  ];

  const findings = analyzeLegLayovers(legs);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].layoverMinutes, 30);
  assert.equal(findings[0].minimumMinutes, MIN_CONNECTION_MINUTES);
  assert.equal(findings[0].tight, true);
  assert.equal(findings[1].layoverMinutes, 90);
  assert.equal(findings[1].tight, false);
});

test("analyzeLegLayovers: international connections need a longer minimum", () => {
  const legs = [
    leg("2026-08-10T08:00:00Z", "2026-08-10T09:30:00Z"),
    // 60 minutes -- fine domestically, tight once customs/immigration is in play.
    leg("2026-08-10T10:30:00Z", "2026-08-10T12:00:00Z"),
  ];

  const domestic = analyzeLegLayovers(legs, false);
  assert.equal(domestic[0].tight, false);

  const international = analyzeLegLayovers(legs, true);
  assert.equal(international[0].minimumMinutes, MIN_INTERNATIONAL_CONNECTION_MINUTES);
  assert.equal(international[0].tight, true);
});

test("analyzeLegLayovers: a single leg has no connections to analyze", () => {
  assert.deepEqual(analyzeLegLayovers([leg("2026-08-10T08:00:00Z", "2026-08-10T09:30:00Z")]), []);
});

test("deriveScheduleFromLegs: startsAt is the first leg's departure, endsAt the last leg's arrival", () => {
  const legs = [
    leg("2026-08-10T08:00:00Z", "2026-08-10T09:30:00Z"),
    leg("2026-08-10T10:00:00Z", "2026-08-10T12:00:00Z"),
  ];
  const schedule = deriveScheduleFromLegs(legs);
  assert.equal(schedule?.startsAt.toISOString(), "2026-08-10T08:00:00.000Z");
  assert.equal(schedule?.endsAt.toISOString(), "2026-08-10T12:00:00.000Z");
});

test("deriveScheduleFromLegs: a nonstop flight's schedule is just its one leg", () => {
  const only = leg("2026-08-10T08:00:00Z", "2026-08-10T09:30:00Z");
  const schedule = deriveScheduleFromLegs([only]);
  assert.equal(schedule?.startsAt, only.departsAt);
  assert.equal(schedule?.endsAt, only.arrivesAt);
});

test("deriveScheduleFromLegs: null for an empty leg list -- rejecting that is a validation policy for the caller, not a fact this pure function asserts", () => {
  assert.equal(deriveScheduleFromLegs([]), null);
});
