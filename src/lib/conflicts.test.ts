import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTimeline, type ScheduleItem } from "./conflicts.ts";
import type { TravelEstimate, TravelMode, TravelTimeProvider } from "./travel.ts";

/** Deterministic stand-in: fixed minutes/overhead regardless of coordinates. */
class FixedTravelTimeProvider implements TravelTimeProvider {
  private minutes: number;
  private overheadMinutes: number;
  constructor(minutes: number, overheadMinutes = 0) {
    this.minutes = minutes;
    this.overheadMinutes = overheadMinutes;
  }
  async estimate(): Promise<TravelEstimate> {
    return { minutes: this.minutes, overheadMinutes: this.overheadMinutes, mode: "drive" as TravelMode };
  }
}

const HERE = { lat: 0, lng: 0 };
const THERE = { lat: 0, lng: 1 };

function item(id: string, startsAt: string, endsAt: string, location: typeof HERE | null = HERE): ScheduleItem {
  return { id, title: id, startsAt: new Date(startsAt), endsAt: new Date(endsAt), location };
}

test("the 45/45 example: a 45-minute gap for a 45-minute drive is tight, not a conflict", async () => {
  const timeline = [
    item("museum", "2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z", HERE),
    item("dinner", "2026-06-01T11:45:00Z", "2026-06-01T13:00:00Z", THERE),
  ];
  const [finding] = await analyzeTimeline(timeline, new FixedTravelTimeProvider(45, 0));

  assert.equal(finding.gapMinutes, 45);
  assert.equal(finding.slackMinutes, 0);
  assert.equal(finding.severity, "tight", "zero slack should read as tight, not a hard conflict");
});

test("overhead makes an apparently-fine gap into a real conflict", async () => {
  // 45 minute gap, 45 minute drive, but parking/walking eats 15 more minutes.
  const timeline = [
    item("a", "2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z"),
    item("b", "2026-06-01T11:45:00Z", "2026-06-01T13:00:00Z", THERE),
  ];
  const [finding] = await analyzeTimeline(timeline, new FixedTravelTimeProvider(45, 15));

  assert.equal(finding.slackMinutes, -15);
  assert.equal(finding.severity, "conflict");
});

test("a generous gap relative to travel time is fine", async () => {
  const timeline = [
    item("a", "2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z"),
    item("b", "2026-06-01T12:00:00Z", "2026-06-01T13:00:00Z", THERE),
  ];
  const [finding] = await analyzeTimeline(timeline, new FixedTravelTimeProvider(10, 5));

  assert.equal(finding.gapMinutes, 60);
  assert.equal(finding.slackMinutes, 45);
  assert.equal(finding.severity, "ok");
});

test("overlapping items are always a conflict, regardless of travel time", async () => {
  const timeline = [
    item("a", "2026-06-01T10:00:00Z", "2026-06-01T12:00:00Z"),
    item("b", "2026-06-01T11:00:00Z", "2026-06-01T13:00:00Z"),
  ];
  const [finding] = await analyzeTimeline(timeline, new FixedTravelTimeProvider(0));

  assert.equal(finding.reason, "overlap");
  assert.equal(finding.severity, "conflict");
  assert.equal(finding.gapMinutes, -60);
});

test("items without a location are not flagged, just unanalyzable", async () => {
  const timeline = [
    item("a", "2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z", null),
    item("b", "2026-06-01T11:05:00Z", "2026-06-01T12:00:00Z", HERE),
  ];
  const [finding] = await analyzeTimeline(timeline, new FixedTravelTimeProvider(999));

  assert.equal(finding.reason, "no-location");
  assert.equal(finding.severity, "ok");
});

test("an item with no items after it produces no findings", async () => {
  const findings = await analyzeTimeline([item("solo", "2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z")]);
  assert.equal(findings.length, 0);
});

test("timeline is analyzed in chronological order regardless of input order", async () => {
  const timeline = [
    item("late", "2026-06-01T14:00:00Z", "2026-06-01T15:00:00Z"),
    item("early", "2026-06-01T10:00:00Z", "2026-06-01T11:00:00Z"),
  ];
  const [finding] = await analyzeTimeline(timeline, new FixedTravelTimeProvider(5));
  assert.equal(finding.before.id, "early");
  assert.equal(finding.after.id, "late");
});
