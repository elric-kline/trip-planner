import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictsForViewer, groupTimelineFor, previewLockImpact } from "./conflicts-for.ts";
import { flagged } from "./conflicts.ts";
import { createItem, lockItem, scheduleItem, setRsvp } from "./items.ts";
import { getItem, requireTripAccess } from "./scope.ts";
import { upsertTransportDetails, setTransportLegs } from "./transport.ts";
import type { FlightStatus, FlightStatusProvider } from "./flight-status.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

/**
 * Always resolves the same fixed status, regardless of which leg is
 * queried -- enough to prove conflict analysis actually consults a live
 * provider when one is given. Not a constructor parameter property -- see
 * scope.ts's AccessError doc for why that TS shorthand doesn't survive
 * plain `node --experimental-strip-types`.
 */
class FixedFlightStatusProvider implements FlightStatusProvider {
  status: FlightStatus;
  constructor(status: FlightStatus) {
    this.status = status;
  }
  async lookup(): Promise<FlightStatus> {
    return this.status;
  }
}

function flightStatus(overrides: Partial<FlightStatus> = {}): FlightStatus {
  return {
    status: "active",
    estimatedDepartsAt: null,
    estimatedArrivesAt: null,
    actualDepartsAt: null,
    actualArrivesAt: null,
    departureGate: null,
    departureTerminal: null,
    arrivalGate: null,
    arrivalTerminal: null,
    baggageClaim: null,
    ...overrides,
  };
}

async function setupTrip() {
  const planner = await createTestUser();
  const memberA = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, memberA.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  const memberAAccess = await requireTripAccess(trip.id, memberA);
  return { trip, userIds: [planner.id, memberA.id], planner, memberA, plannerAccess, memberAAccess };
}

async function lockedRequired(access: Awaited<ReturnType<typeof requireTripAccess>>, title: string, startsAt: Date) {
  const created = await createItem(access, { title });
  const proposed = await scheduleItem(access, created.id, startsAt, null);
  return lockItem(access, proposed.id, "required");
}

test("conflictsForViewer flags two overlapping required items as a conflict", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Museum tour", new Date("2026-09-01T09:00:00Z")); // occupies 9:00-10:00 (default duration)
  await lockedRequired(plannerAccess, "Cooking class", new Date("2026-09-01T09:30:00Z")); // overlaps it

  const findings = flagged(await conflictsForViewer(plannerAccess));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "conflict");
  assert.equal(findings[0].reason, "overlap");
});

test("conflictsForViewer excludes an optional item the viewer hasn't RSVP'd yes to", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Required stop", new Date("2026-09-02T09:00:00Z"));
  const optionalProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Optional overlapping stop" })).id,
    new Date("2026-09-02T09:30:00Z"),
    null,
  );
  const optional = await lockItem(plannerAccess, optionalProposed.id, "optional");

  // Not RSVP'd yet -- the optional item isn't in the viewer's attending timeline.
  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 0);

  await setRsvp(plannerAccess, optional.id, "yes");
  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 1, "now it counts");
});

test("conflictsForViewer includes the viewer's own private items -- that's the one place private plans enter conflict math", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Group activity", new Date("2026-09-03T09:00:00Z"));

  const privateProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "My own overlapping errand", visibility: "private" })).id,
    new Date("2026-09-03T09:30:00Z"),
    null,
  );
  // A private item is locked by its own author, with no commitment.
  await lockItem(plannerAccess, privateProposed.id, null);

  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 1);
});

test("conflictsForViewer widens a transport item's window by its subtype buffer -- a drive's parking allowance turns a fine-looking gap into an overlap", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const driveProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Drive to venue", category: "transport" })).id,
    new Date("2026-09-10T10:00:00Z"),
    new Date("2026-09-10T10:20:00Z"),
  );
  const drive = await lockItem(plannerAccess, driveProposed.id, "required");
  await upsertTransportDetails(plannerAccess, drive.id, { subtype: "drive" });

  // 5 minute raw gap after the drive's own endsAt -- neither item has a
  // location, so without the buffer this wouldn't even be flagged (reason
  // "no-location", severity ok). Drive's 10-minute parking buffer eats the
  // gap and then some.
  await lockedRequired(plannerAccess, "Lunch", new Date("2026-09-10T10:25:00Z"));

  const findings = flagged(await conflictsForViewer(plannerAccess));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "overlap");
  assert.equal(findings[0].before.id, drive.id);
});

test("conflictsForViewer resolves a flight's window from live status when a provider supplies one -- a delay outside the original schedule can turn a fine gap into a conflict", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const flight = await createItem(plannerAccess, { title: "UA100 SFO-JFK", category: "transport" });
  await upsertTransportDetails(plannerAccess, flight.id, { subtype: "flight" });
  await setTransportLegs(plannerAccess, flight.id, [
    {
      flightNumber: "UA100",
      departsAt: new Date("2026-09-11T08:00:00Z"),
      arrivesAt: new Date("2026-09-11T10:00:00Z"),
    },
  ]);
  await lockItem(plannerAccess, (await getItem(plannerAccess, flight.id)).id, "required");

  // Domestic flight buffer is 90 pre / 30 post. Raw arrival 10:00 + 30 =
  // 10:30 -- five minutes of slack before an 10:35 meeting, no conflict yet.
  await lockedRequired(plannerAccess, "Team meeting", new Date("2026-09-11T10:35:00Z"));
  assert.equal(flagged(await conflictsForViewer(plannerAccess)).length, 0);

  // The airline pushes the actual arrival estimate an hour later -- nothing
  // about the stored schedule changed, only what a live lookup reports.
  const delayed = new FixedFlightStatusProvider(
    flightStatus({ estimatedArrivesAt: new Date("2026-09-11T11:00:00Z") }),
  );
  const findings = flagged(await conflictsForViewer(plannerAccess, undefined, delayed));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "overlap");
});

// Newark (departure) and Seattle (landing + lodging) -- real coordinates,
// picked specifically so a Haversine estimate between them is huge (the
// exact false-conflict shape this fix eliminates: a flight's own
// departure point standing in for where it actually lands).
const EWR = { lat: 40.6895, lng: -74.1745 };
const SEATTLE_AIRPORT = { lat: 47.4502, lng: -122.3088 };
const SEATTLE_LODGING = { lat: 47.6205, lng: -122.3493 }; // a few miles from the airport, inside the city

test("conflictsForViewer uses a flight's actual landing point for the next item, not its departure -- landing and checking in both in Seattle isn't a cross-country drive", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const flight = await createItem(plannerAccess, {
    title: "Newark Flight",
    category: "transport",
    locationLat: EWR.lat,
    locationLng: EWR.lng,
  });
  await upsertTransportDetails(plannerAccess, flight.id, { subtype: "flight" });
  await setTransportLegs(plannerAccess, flight.id, [
    {
      flightNumber: "UA100",
      departureAirport: "EWR",
      arrivalAirport: "SEA",
      arrivalLat: SEATTLE_AIRPORT.lat,
      arrivalLng: SEATTLE_AIRPORT.lng,
      departsAt: new Date("2026-09-11T08:00:00Z"),
      arrivesAt: new Date("2026-09-11T12:00:00Z"),
    },
  ]);
  await lockItem(plannerAccess, (await getItem(plannerAccess, flight.id)).id, "required");

  await lockItem(
    plannerAccess,
    (
      await scheduleItem(
        plannerAccess,
        (
          await createItem(plannerAccess, {
            title: "Modern Queen Anne Retreat with Rooftop",
            locationLat: SEATTLE_LODGING.lat,
            locationLng: SEATTLE_LODGING.lng,
          })
        ).id,
        new Date("2026-09-11T16:00:00Z"), // 4pm check-in, same as reported
        null,
      )
    ).id,
    "required",
  );

  const findings = flagged(await conflictsForViewer(plannerAccess));
  assert.deepEqual(findings, [], "landing and checking in both in Seattle should never read as a cross-country drive");
});

test("conflictsForViewer treats a flight with no resolvable landing point as unanalyzable, not as still being at its departure point", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const flight = await createItem(plannerAccess, {
    title: "Newark Flight",
    category: "transport",
    locationLat: EWR.lat,
    locationLng: EWR.lng,
  });
  await upsertTransportDetails(plannerAccess, flight.id, { subtype: "flight" });
  await setTransportLegs(plannerAccess, flight.id, [
    // No arrivalLat/arrivalLng -- e.g. the airport code never geocoded.
    {
      flightNumber: "UA100",
      departsAt: new Date("2026-09-11T08:00:00Z"),
      arrivesAt: new Date("2026-09-11T12:00:00Z"),
    },
  ]);
  await lockItem(plannerAccess, (await getItem(plannerAccess, flight.id)).id, "required");

  await lockItem(
    plannerAccess,
    (
      await scheduleItem(
        plannerAccess,
        (
          await createItem(plannerAccess, {
            title: "Modern Queen Anne Retreat with Rooftop",
            locationLat: SEATTLE_LODGING.lat,
            locationLng: SEATTLE_LODGING.lng,
          })
        ).id,
        new Date("2026-09-11T16:00:00Z"),
        null,
      )
    ).id,
    "required",
  );

  const findings = await conflictsForViewer(plannerAccess);
  const flightToLodging = findings.find((f) => f.before.id === flight.id);
  assert.equal(flightToLodging?.reason, "no-location");
  assert.equal(flightToLodging?.severity, "ok");
});

test("groupTimelineFor: required items always included; optional items only when the member RSVP'd yes", async (t) => {
  const { trip, userIds, plannerAccess, memberA } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const required = await lockedRequired(plannerAccess, "Required", new Date("2026-09-04T09:00:00Z"));
  const optionalProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Optional" })).id,
    new Date("2026-09-04T11:00:00Z"),
    null,
  );
  const optional = await lockItem(plannerAccess, optionalProposed.id, "optional");

  const groupItems = [required, optional];
  const noRsvps = new Map<string, Map<string, string>>();
  const withoutRsvp = await groupTimelineFor(memberA.id, groupItems, noRsvps);
  assert.deepEqual(withoutRsvp.map((i) => i.id), [required.id]);

  const withYes = new Map([[optional.id, new Map([[memberA.id, "yes"]])]]);
  const withRsvp = await groupTimelineFor(memberA.id, groupItems, withYes);
  assert.equal(withRsvp.length, 2);
});

test("previewLockImpact: no time or a private candidate means nothing to preview", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const idea = await createItem(plannerAccess, { title: "No time yet" });
  assert.deepEqual(await previewLockImpact(plannerAccess, idea, "required"), []);

  const privateProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Private candidate", visibility: "private" })).id,
    new Date("2026-09-05T09:00:00Z"),
    null,
  );
  assert.deepEqual(await previewLockImpact(plannerAccess, privateProposed, "required"), []);
});

test("previewLockImpact: locking a required candidate that overlaps an existing item surfaces the new conflict for every member", async (t) => {
  const { trip, userIds, plannerAccess, memberA } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  await lockedRequired(plannerAccess, "Already locked", new Date("2026-09-06T09:00:00Z"));
  const candidate = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "About to lock, overlapping" })).id,
    new Date("2026-09-06T09:30:00Z"),
    null,
  );

  const impacts = await previewLockImpact(plannerAccess, candidate, "required");
  const affectedIds = impacts.map((i) => i.member.userId).sort();
  assert.deepEqual(affectedIds, [memberA.id, plannerAccess.viewer.id].sort());
  for (const impact of impacts) {
    assert.ok(impact.newFindings.length > 0);
  }
});
