import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getTransportDetails,
  getTransportLegs,
  upsertTransportDetails,
  setTransportLegs,
} from "./transport.ts";
import { RuleError, createItem, lockItem, scheduleItem } from "./items.ts";
import { getItem, requireTripAccess } from "./scope.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

test("getTransportDetails is null until something is saved; upsertTransportDetails then creates or replaces", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "Train to Lyon", category: "transport" });
  assert.equal(await getTransportDetails(item.id), null);

  await upsertTransportDetails(access, item.id, { subtype: "train", confirmationNumber: "SNCF1" });
  const first = await getTransportDetails(item.id);
  assert.equal(first?.subtype, "train");
  assert.equal(first?.confirmationNumber, "SNCF1");

  await upsertTransportDetails(access, item.id, { subtype: "train", confirmationNumber: "SNCF2" });
  const second = await getTransportDetails(item.id);
  assert.equal(second?.confirmationNumber, "SNCF2");
});

test("upsertTransportDetails round-trips a non-flight subtype's own destination -- distinct from the item's own location, which is its departure point", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "Drive to the coast", category: "transport" });
  const saved = await upsertTransportDetails(access, item.id, {
    subtype: "drive",
    destinationName: "Half Moon Bay, CA",
    destinationLat: 37.4636,
    destinationLng: -122.4286,
  });
  assert.equal(saved.destinationName, "Half Moon Bay, CA");
  assert.equal(saved.destinationLat, 37.4636);
  assert.equal(saved.destinationLng, -122.4286);

  const fetched = await getTransportDetails(item.id);
  assert.equal(fetched?.destinationName, "Half Moon Bay, CA");
});

test("upsertTransportDetails rejects a non-transport item and a bookedBy who isn't on the trip", async (t) => {
  const planner = await createTestUser();
  const outsider = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id, outsider.id]));
  const access = await requireTripAccess(trip.id, planner);

  const activity = await createItem(access, { title: "Hike", category: "activity" });
  await assert.rejects(
    () => upsertTransportDetails(access, activity.id, { subtype: "train" }),
    RuleError,
  );

  const drive = await createItem(access, { title: "Drive to trailhead", category: "transport" });
  await assert.rejects(
    () => upsertTransportDetails(access, drive.id, { subtype: "drive", bookedBy: outsider.id }),
    RuleError,
  );
});

test("upsertTransportDetails follows canEditItem: locked items are planner-only, even post-lock", async (t) => {
  const planner = await createTestUser();
  const author = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, author.id, "participant");
  t.after(() => cleanupTrip(trip.id, [planner.id, author.id]));

  const authorAccess = await requireTripAccess(trip.id, author);
  const plannerAccess = await requireTripAccess(trip.id, planner);

  const item = await createItem(authorAccess, { title: "Rideshare to airport", category: "transport" });
  await upsertTransportDetails(authorAccess, item.id, { subtype: "rideshare" });

  const proposed = await scheduleItem(authorAccess, item.id, new Date("2026-08-01T15:00:00Z"), null);
  const locked = await lockItem(plannerAccess, proposed.id, "required");

  await assert.rejects(
    () => upsertTransportDetails(authorAccess, locked.id, { subtype: "rideshare", confirmationNumber: "x" }),
    RuleError,
  );

  // Booking details are exactly what a planner may still correct post-lock, same as lodging/dining.
  await upsertTransportDetails(plannerAccess, locked.id, { subtype: "rideshare", confirmationNumber: "ABC123" });
  const details = await getTransportDetails(locked.id);
  assert.equal(details?.confirmationNumber, "ABC123");
});

test("setTransportLegs stores a connecting itinerary in order and syncs the item's own startsAt/endsAt to the first departure and last arrival", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "SFO -> CDG via JFK", category: "transport" });
  await upsertTransportDetails(access, item.id, { subtype: "flight", international: true });

  const legs = await setTransportLegs(access, item.id, [
    {
      airline: "United",
      flightNumber: "UA123",
      departureAirport: "SFO",
      arrivalAirport: "JFK",
      departsAt: new Date("2026-08-10T08:00:00Z"),
      arrivesAt: new Date("2026-08-10T16:30:00Z"),
    },
    {
      airline: "Air France",
      flightNumber: "AF456",
      departureAirport: "JFK",
      arrivalAirport: "CDG",
      departsAt: new Date("2026-08-10T19:00:00Z"),
      arrivesAt: new Date("2026-08-11T08:15:00Z"),
    },
  ]);

  assert.equal(legs.length, 2);
  assert.equal(legs[0].legOrder, 0);
  assert.equal(legs[1].legOrder, 1);
  assert.equal(legs[0].flightNumber, "UA123");
  assert.equal(legs[1].flightNumber, "AF456");

  const stored = await getTransportLegs(item.id);
  assert.deepEqual(stored.map((l) => l.flightNumber), ["UA123", "AF456"]);

  const updatedItem = await getItem(access, item.id);
  assert.equal(updatedItem.startsAt?.toISOString(), "2026-08-10T08:00:00.000Z");
  assert.equal(updatedItem.endsAt?.toISOString(), "2026-08-11T08:15:00.000Z");
});

test("setTransportLegs rejects non-flight subtypes, empty lists, and out-of-order legs", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const drive = await createItem(access, { title: "Drive north", category: "transport" });
  await upsertTransportDetails(access, drive.id, { subtype: "drive" });
  await assert.rejects(
    () =>
      setTransportLegs(access, drive.id, [
        { departsAt: new Date("2026-08-10T08:00:00Z"), arrivesAt: new Date("2026-08-10T09:00:00Z") },
      ]),
    /flight-subtype/,
  );

  const flight = await createItem(access, { title: "Nonstop", category: "transport" });
  await upsertTransportDetails(access, flight.id, { subtype: "flight" });
  await assert.rejects(() => setTransportLegs(access, flight.id, []), /at least one leg/);

  await assert.rejects(
    () =>
      setTransportLegs(access, flight.id, [
        { departsAt: new Date("2026-08-10T10:00:00Z"), arrivesAt: new Date("2026-08-10T09:00:00Z") },
      ]),
    /arrival must come after/,
  );

  await assert.rejects(
    () =>
      setTransportLegs(access, flight.id, [
        { departsAt: new Date("2026-08-10T08:00:00Z"), arrivesAt: new Date("2026-08-10T12:00:00Z") },
        { departsAt: new Date("2026-08-10T10:00:00Z"), arrivesAt: new Date("2026-08-10T14:00:00Z") },
      ]),
    /depart after the previous leg arrives/,
  );
});

test("setTransportLegs replaces the previous set of legs rather than appending", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "Reroute", category: "transport" });
  await upsertTransportDetails(access, item.id, { subtype: "flight" });

  await setTransportLegs(access, item.id, [
    { departsAt: new Date("2026-08-10T08:00:00Z"), arrivesAt: new Date("2026-08-10T10:00:00Z") },
    { departsAt: new Date("2026-08-10T11:00:00Z"), arrivesAt: new Date("2026-08-10T13:00:00Z") },
  ]);

  // Airline rebooked it nonstop -- one leg replaces both.
  const rebooked = await setTransportLegs(access, item.id, [
    { departsAt: new Date("2026-08-10T09:00:00Z"), arrivesAt: new Date("2026-08-10T12:00:00Z") },
  ]);

  assert.equal(rebooked.length, 1);
  const stored = await getTransportLegs(item.id);
  assert.equal(stored.length, 1);
});

test("upsertTransportDetails drops legs when the subtype moves off \"flight\"", async (t) => {
  const planner = await createTestUser();
  const trip = await createTestTrip(planner);
  t.after(() => cleanupTrip(trip.id, [planner.id]));
  const access = await requireTripAccess(trip.id, planner);

  const item = await createItem(access, { title: "Changed my mind", category: "transport" });
  await upsertTransportDetails(access, item.id, { subtype: "flight" });
  await setTransportLegs(access, item.id, [
    { departsAt: new Date("2026-08-10T08:00:00Z"), arrivesAt: new Date("2026-08-10T10:00:00Z") },
  ]);
  assert.equal((await getTransportLegs(item.id)).length, 1);

  await upsertTransportDetails(access, item.id, { subtype: "drive" });
  assert.equal((await getTransportLegs(item.id)).length, 0);
});
