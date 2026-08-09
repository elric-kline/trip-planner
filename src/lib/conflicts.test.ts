import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTimeline, windowsOverlap, itemsConflict, flagged, type ScheduleItem } from "./conflicts.ts";
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

/** Stationary by default: destinationLocation mirrors location, same as a dining/lodging/activity item. */
function item(
  id: string,
  startsAt: string,
  endsAt: string,
  location: typeof HERE | null = HERE,
  destinationLocation: typeof HERE | null = location,
): ScheduleItem {
  return { id, title: id, startsAt: new Date(startsAt), endsAt: new Date(endsAt), location, destinationLocation };
}

function lodging(id: string, startsAt: string, endsAt: string, location: typeof HERE | null = HERE): ScheduleItem {
  return { ...item(id, startsAt, endsAt, location), isLodging: true };
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

/** Records exactly what coordinates it was asked to route between, so a test can assert on them directly rather than inferring from a stubbed travel time. */
class RecordingTravelTimeProvider implements TravelTimeProvider {
  calls: [typeof HERE, typeof HERE][] = [];
  async estimate(from: typeof HERE, to: typeof HERE): Promise<TravelEstimate> {
    this.calls.push([from, to]);
    return { minutes: 20, overheadMinutes: 0, mode: "drive" as TravelMode };
  }
}

test("a directional item's destination, not its own location, governs travel to what's next -- the flight-landed-somewhere-else case", async () => {
  const FAR = { lat: 40, lng: -74 }; // e.g. where the flight took off from
  const timeline = [
    // Departs from FAR, lands at THERE -- destinationLocation is where it actually ends up.
    item("flight", "2026-06-01T08:00:00Z", "2026-06-01T11:00:00Z", FAR, THERE),
    item("hotel-checkin", "2026-06-01T15:00:00Z", "2026-06-01T16:00:00Z", THERE),
  ];
  const provider = new RecordingTravelTimeProvider();
  const [finding] = await analyzeTimeline(timeline, provider);

  // The estimate must be routed from where the flight landed (THERE), not
  // where it took off (FAR) -- using FAR here is exactly the cross-country
  // false conflict this fix eliminates.
  assert.deepEqual(provider.calls, [[THERE, THERE]]);
  assert.equal(finding.reason, "travel");
  assert.equal(finding.gapMinutes, 240);
  assert.equal(finding.slackMinutes, 220);
  assert.equal(finding.severity, "ok");
});

test("a directional item with no known destination is unanalyzable, not silently treated as still being where it started", async () => {
  const timeline = [
    // Destination unknown (e.g. a flight with no geocoded arrival yet) --
    // must NOT fall back to `location`, or this would wrongly compute a
    // cross-country drive from HERE instead of admitting it doesn't know.
    item("flight", "2026-06-01T08:00:00Z", "2026-06-01T11:00:00Z", HERE, null),
    item("hotel-checkin", "2026-06-01T11:30:00Z", "2026-06-01T12:30:00Z", HERE),
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

test("windowsOverlap treats a missing end as the default duration", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 11, h, m));
  // 9:00 with no end occupies 9:00-10:00.
  assert.equal(windowsOverlap({ startsAt: at(9), endsAt: null }, { startsAt: at(9, 30), endsAt: at(11) }), true);
  assert.equal(windowsOverlap({ startsAt: at(9), endsAt: null }, { startsAt: at(10), endsAt: at(11) }), false);
});

test("windowsOverlap is half-open, so touching items don't collide", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 11, h));
  assert.equal(windowsOverlap({ startsAt: at(9), endsAt: at(12) }, { startsAt: at(12), endsAt: at(14) }), false);
  assert.equal(windowsOverlap({ startsAt: at(9), endsAt: at(12) }, { startsAt: at(11), endsAt: at(14) }), true);
});

test("windowsOverlap catches full containment either way round", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 11, h));
  const outer = { startsAt: at(9), endsAt: at(18) };
  const inner = { startsAt: at(12), endsAt: at(13) };
  assert.equal(windowsOverlap(outer, inner), true);
  assert.equal(windowsOverlap(inner, outer), true);
});

// -- Lodging: doesn't occupy its whole span, only its edges. --

test("a multi-day lodging stay does not conflict with things comfortably nested inside it", async () => {
  const timeline = [
    lodging("hotel", "2026-06-01T15:00:00Z", "2026-06-03T11:00:00Z"),
    // Well clear of both the 15:00 check-in and the 11:00 checkout.
    item("dinner-day1", "2026-06-01T19:00:00Z", "2026-06-01T21:00:00Z"),
    item("brunch-day2", "2026-06-02T10:00:00Z", "2026-06-02T12:00:00Z"),
    item("museum-day2", "2026-06-02T14:00:00Z", "2026-06-02T16:00:00Z"),
  ];
  const findings = await analyzeTimeline(timeline, new FixedTravelTimeProvider(10, 0));

  // This is the exact bug report: a 2-day stay must not show up as
  // conflicting with everything scheduled during it. (Raw findings still
  // include an "ok" travel entry wherever the check-in/check-out sub-events
  // happen to be adjacent to something in sorted order -- same as any other
  // item -- so this checks what actually surfaces, flagged() output, same
  // as the trip page itself.)
  for (const f of flagged(findings)) {
    assert.notEqual(f.before.id, "hotel", `unexpected finding involving the stay: ${JSON.stringify(f)}`);
    assert.notEqual(f.after.id, "hotel", `unexpected finding involving the stay: ${JSON.stringify(f)}`);
  }
});

test("something scheduled right at check-in is still flagged -- the arrival buffer is real", async () => {
  const timeline = [
    lodging("hotel", "2026-06-01T15:00:00Z", "2026-06-03T11:00:00Z"),
    // 15 minutes after arrival -- nowhere near enough time to actually check in first.
    item("tour", "2026-06-01T15:15:00Z", "2026-06-01T16:00:00Z"),
  ];
  const findings = await analyzeTimeline(timeline, new FixedTravelTimeProvider(0, 0));

  const involvingHotel = flagged(findings).filter((f) => f.before.id === "hotel" || f.after.id === "hotel");
  assert.equal(involvingHotel.length, 1);
  assert.equal(involvingHotel[0].severity, "conflict");
  assert.match(involvingHotel[0].before.title, /check-in/);
});

test("something scheduled right before checkout is still flagged -- the departure buffer is real", async () => {
  const timeline = [
    lodging("hotel", "2026-06-01T15:00:00Z", "2026-06-03T11:00:00Z"),
    // Ends 15 minutes before the departure buffer opens (10:00) at a
    // 30-minute drive away -- not enough slack to get back and check out.
    item("morning-walk", "2026-06-03T09:00:00Z", "2026-06-03T09:45:00Z", THERE),
  ];
  const findings = await analyzeTimeline(timeline, new FixedTravelTimeProvider(30, 0));

  const involvingHotel = flagged(findings).filter((f) => f.before.id === "hotel" || f.after.id === "hotel");
  assert.equal(involvingHotel.length, 1);
  assert.equal(involvingHotel[0].severity, "conflict");
  assert.match(involvingHotel[0].after.title, /check-out/);
});

test("two overlapping lodging stays are a hard conflict, regardless of travel time -- nobody's staying two places overnight", async () => {
  const timeline = [
    lodging("hotel-a", "2026-06-01T15:00:00Z", "2026-06-03T11:00:00Z"),
    lodging("hotel-b", "2026-06-02T15:00:00Z", "2026-06-04T11:00:00Z"),
  ];
  const findings = await analyzeTimeline(timeline, new FixedTravelTimeProvider(0, 0));

  const overlap = findings.find((f) => f.reason === "overlap" && f.before.id === "hotel-a" && f.after.id === "hotel-b");
  assert.ok(overlap, "expected a hard conflict between the two overlapping stays");
  assert.equal(overlap.severity, "conflict");
  // The finding names the real stays, not check-in/check-out sub-events.
  assert.equal(overlap.before.title, "hotel-a");
  assert.equal(overlap.after.title, "hotel-b");
});

test("non-overlapping back-to-back lodging stays are judged on ordinary travel time between them, not flagged as a hard conflict", async () => {
  const timeline = [
    lodging("hotel-a", "2026-06-01T15:00:00Z", "2026-06-02T11:00:00Z"),
    lodging("hotel-b", "2026-06-02T15:00:00Z", "2026-06-03T11:00:00Z", THERE),
  ];
  const findings = await analyzeTimeline(timeline, new FixedTravelTimeProvider(30, 0));

  assert.equal(findings.filter((f) => f.reason === "overlap").length, 0);
});

test("itemsConflict: lodging only clashes with another lodging or its own arrival/departure buffer, not the whole stay", () => {
  const stay = { startsAt: new Date("2026-06-01T15:00:00Z"), endsAt: new Date("2026-06-03T11:00:00Z"), category: "lodging" };

  // Comfortably inside the stay -- not a clash.
  assert.equal(
    itemsConflict(stay, { startsAt: new Date("2026-06-02T12:00:00Z"), endsAt: new Date("2026-06-02T13:00:00Z"), category: "dining" }),
    false,
  );
  // Inside the arrival buffer.
  assert.equal(
    itemsConflict(stay, { startsAt: new Date("2026-06-01T15:10:00Z"), endsAt: new Date("2026-06-01T16:00:00Z"), category: "activity" }),
    true,
  );
  // Inside the departure buffer.
  assert.equal(
    itemsConflict(stay, { startsAt: new Date("2026-06-03T10:45:00Z"), endsAt: new Date("2026-06-03T12:00:00Z"), category: "activity" }),
    true,
  );
  // Another overlapping lodging stay -- always a clash.
  assert.equal(
    itemsConflict(stay, { startsAt: new Date("2026-06-02T00:00:00Z"), endsAt: new Date("2026-06-02T10:00:00Z"), category: "lodging" }),
    true,
  );
  // Two ordinary items still use plain overlap.
  assert.equal(
    itemsConflict(
      { startsAt: new Date("2026-06-01T10:00:00Z"), endsAt: new Date("2026-06-01T12:00:00Z"), category: "dining" },
      { startsAt: new Date("2026-06-01T11:00:00Z"), endsAt: new Date("2026-06-01T13:00:00Z"), category: "activity" },
    ),
    true,
  );
});
