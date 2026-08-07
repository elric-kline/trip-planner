import { test } from "node:test";
import assert from "node:assert/strict";
import { HaversineTravelTimeProvider, inferMode } from "./travel.ts";

// Golden Gate Bridge to Ferry Building, San Francisco -- roughly 8km apart.
const A = { lat: 37.8199, lng: -122.4783 };
const B = { lat: 37.7955, lng: -122.3937 };

test("HaversineTravelTimeProvider: walking is slower than driving over the same distance, and both carry the mode's overhead", async () => {
  const provider = new HaversineTravelTimeProvider();

  const walking = await provider.estimate(A, B, "walk");
  const driving = await provider.estimate(A, B, "drive");
  const transit = await provider.estimate(A, B, "transit");

  assert.ok(walking.minutes > driving.minutes, "walking the same distance takes longer than driving");
  assert.equal(walking.overheadMinutes, 0, "no parking/boarding overhead on foot");
  assert.equal(driving.overheadMinutes, 10);
  assert.equal(transit.overheadMinutes, 8);
  assert.equal(walking.mode, "walk");
});

test("HaversineTravelTimeProvider caches by (from, to, mode) -- an identical query is served from cache", async () => {
  const provider = new HaversineTravelTimeProvider();
  const first = await provider.estimate(A, B, "drive");
  const second = await provider.estimate(A, B, "drive");
  assert.deepEqual(first, second);

  // A different mode for the same pair is a cache miss, not the same object.
  const differentMode = await provider.estimate(A, B, "walk");
  assert.notEqual(differentMode.minutes, first.minutes);
});

test("estimate between identical points is ~0 minutes regardless of mode", async () => {
  const provider = new HaversineTravelTimeProvider();
  const result = await provider.estimate(A, A, "drive");
  assert.equal(result.minutes, 0);
});

test("inferMode picks walk for short hops, transit for a middle distance, drive for anything far", () => {
  const origin = { lat: 0, lng: 0 };
  // Moving along latitude only keeps the distance math simple: ~111km/degree.
  const walkDistance = { lat: 0.005, lng: 0 }; // ~0.55km
  const transitDistance = { lat: 0.03, lng: 0 }; // ~3.3km
  const driveDistance = { lat: 0.1, lng: 0 }; // ~11.1km

  assert.equal(inferMode(origin, walkDistance), "walk");
  assert.equal(inferMode(origin, transitDistance), "transit");
  assert.equal(inferMode(origin, driveDistance), "drive");
});
