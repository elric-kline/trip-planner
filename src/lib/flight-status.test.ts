import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AeroDataBoxFlightStatusProvider,
  NoopFlightStatusProvider,
  effectiveLegTimes,
  toFlightStatus,
  type FlightStatus,
  type FlightStatusProvider,
} from "./flight-status.ts";

function clearEnv() {
  delete process.env.AERODATABOX_API_KEY;
}

test("NoopFlightStatusProvider always resolves null and never touches the network", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called");
  });

  const provider: FlightStatusProvider = new NoopFlightStatusProvider();
  const result = await provider.lookup({ flightNumber: "UA123", departureDate: "2026-08-10" });
  assert.equal(result, null);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("effectiveLegTimes: with no status, falls back to scheduled", () => {
  const scheduled = { departsAt: new Date("2026-08-10T08:00:00Z"), arrivesAt: new Date("2026-08-10T10:00:00Z") };
  assert.deepEqual(effectiveLegTimes(scheduled, null), scheduled);
});

function status(overrides: Partial<FlightStatus> = {}): FlightStatus {
  return {
    status: "scheduled",
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

test("effectiveLegTimes: actual beats estimated beats scheduled, decided independently per side", () => {
  const scheduled = { departsAt: new Date("2026-08-10T08:00:00Z"), arrivesAt: new Date("2026-08-10T10:00:00Z") };

  // Departed on time (actual known); still airborne, only an arrival estimate so far.
  const inFlight = status({
    actualDepartsAt: new Date("2026-08-10T08:00:00Z"),
    estimatedArrivesAt: new Date("2026-08-10T10:25:00Z"),
  });
  const resolved = effectiveLegTimes(scheduled, inFlight);
  assert.equal(resolved.departsAt.toISOString(), "2026-08-10T08:00:00.000Z");
  assert.equal(resolved.arrivesAt.toISOString(), "2026-08-10T10:25:00.000Z");

  // Landed -- actual beats the earlier estimate on both sides.
  const landed = status({
    actualDepartsAt: new Date("2026-08-10T08:10:00Z"),
    estimatedDepartsAt: new Date("2026-08-10T08:05:00Z"),
    actualArrivesAt: new Date("2026-08-10T10:20:00Z"),
    estimatedArrivesAt: new Date("2026-08-10T10:25:00Z"),
  });
  const resolvedLanded = effectiveLegTimes(scheduled, landed);
  assert.equal(resolvedLanded.departsAt.toISOString(), "2026-08-10T08:10:00.000Z");
  assert.equal(resolvedLanded.arrivesAt.toISOString(), "2026-08-10T10:20:00.000Z");
});

test("toFlightStatus: parses AeroDataBox's nested scheduled/revised/runway shape, maps status, and carries gate/terminal/baggage through", () => {
  const parsed = toFlightStatus({
    status: "EnRoute",
    departure: {
      scheduledTime: { utc: "2026-08-10 08:00Z" },
      revisedTime: { utc: "2026-08-10 08:20Z" },
      runwayTime: { utc: "2026-08-10 08:22Z" },
      terminal: "3",
      gate: "F2",
    },
    arrival: {
      scheduledTime: { utc: "2026-08-10 10:00Z" },
      revisedTime: { utc: "2026-08-10 10:25Z" },
      terminal: "B",
      gate: "22",
      baggageBelt: "4",
    },
  });

  assert.equal(parsed.status, "active");
  assert.equal(parsed.actualDepartsAt?.toISOString(), "2026-08-10T08:22:00.000Z");
  assert.equal(parsed.estimatedDepartsAt?.toISOString(), "2026-08-10T08:20:00.000Z");
  assert.equal(parsed.actualArrivesAt, null, "no runwayTime yet -- still en route");
  assert.equal(parsed.estimatedArrivesAt?.toISOString(), "2026-08-10T10:25:00.000Z");
  assert.equal(parsed.departureGate, "F2");
  assert.equal(parsed.departureTerminal, "3");
  assert.equal(parsed.arrivalGate, "22");
  assert.equal(parsed.arrivalTerminal, "B");
  assert.equal(parsed.baggageClaim, "4");
});

test("toFlightStatus: tolerates missing fields and an unrecognized status string", () => {
  const parsed = toFlightStatus({});
  assert.equal(parsed.status, "unknown");
  assert.equal(parsed.actualDepartsAt, null);
  assert.equal(parsed.departureGate, null);

  const weird = toFlightStatus({ status: "SomeNewStatusAeroDataBoxAdds" });
  assert.equal(weird.status, "unknown");
});

test("AeroDataBoxFlightStatusProvider: with no API key configured, skips the lookup and returns null", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  const result = await new AeroDataBoxFlightStatusProvider().lookup({
    flightNumber: "UA123",
    departureDate: "2026-08-10",
  });
  assert.equal(result, null);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("AeroDataBoxFlightStatusProvider: a successful lookup parses the first entry and passes the key/flight/date through", async (t) => {
  process.env.AERODATABOX_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify([
          {
            status: "Delayed",
            departure: { revisedTime: { utc: "2026-08-10 08:20Z" } },
            arrival: { revisedTime: { utc: "2026-08-10 10:25Z" } },
          },
        ]),
        { status: 200 },
      ),
  );

  const result = await new AeroDataBoxFlightStatusProvider().lookup({
    flightNumber: "UA123",
    departureDate: "2026-08-10",
  });
  assert.equal(result?.status, "active");
  assert.equal(result?.estimatedDepartsAt?.toISOString(), "2026-08-10T08:20:00.000Z");

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(
    url,
    "https://aerodatabox.p.rapidapi.com/flights/Number/UA123/2026-08-10?dateLocalRole=Departure",
  );
  assert.equal((init.headers as Record<string, string>)["X-RapidAPI-Key"], "test_key");
  clearEnv();
});

test("AeroDataBoxFlightStatusProvider: an empty result array degrades to null", async (t) => {
  process.env.AERODATABOX_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([]), { status: 200 }));

  const result = await new AeroDataBoxFlightStatusProvider().lookup({
    flightNumber: "ZZ999",
    departureDate: "2026-08-10",
  });
  assert.equal(result, null);
  clearEnv();
});

test("AeroDataBoxFlightStatusProvider: a non-OK HTTP response degrades to null instead of throwing", async (t) => {
  process.env.AERODATABOX_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

  const result = await new AeroDataBoxFlightStatusProvider().lookup({
    flightNumber: "UA123",
    departureDate: "2026-08-10",
  });
  assert.equal(result, null);
  clearEnv();
});

test("AeroDataBoxFlightStatusProvider: a network failure degrades to null instead of throwing", async (t) => {
  process.env.AERODATABOX_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });

  const result = await new AeroDataBoxFlightStatusProvider().lookup({
    flightNumber: "UA123",
    departureDate: "2026-08-10",
  });
  assert.equal(result, null);
  clearEnv();
});
