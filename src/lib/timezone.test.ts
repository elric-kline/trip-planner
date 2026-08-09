import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptTypedTimezone,
  canonicalTimezone,
  describeTimezone,
  isValidTimezone,
  timezoneForCoordinates,
} from "./timezone.ts";

function clearEnv() {
  delete process.env.GOOGLE_MAPS_API_KEY;
}

test("isValidTimezone accepts real IANA ids and rejects nonsense", () => {
  assert.equal(isValidTimezone("America/Mexico_City"), true);
  assert.equal(isValidTimezone("Europe/Lisbon"), true);
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("Middle/Earth"), false);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone("   "), false);
});

test("canonicalTimezone resolves legacy abbreviations to the zone Intl will actually use", () => {
  assert.equal(canonicalTimezone("America/Mexico_City"), "America/Mexico_City");
  assert.equal(canonicalTimezone("  Europe/Lisbon  "), "Europe/Lisbon");
  // Intl accepts these, and resolves them somewhere most people wouldn't
  // guess -- EST is Panama, which never observes DST. Storing the resolved id
  // means what's in the database is what the formatter uses.
  assert.equal(canonicalTimezone("CST"), "America/Chicago");
  assert.equal(canonicalTimezone("EST"), "America/Panama");
  assert.equal(canonicalTimezone("Middle/Earth"), null);
  assert.equal(canonicalTimezone(""), null);
});

test("with no API key configured, the lookup is skipped rather than attempted", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  assert.equal(await timezoneForCoordinates(17.06, -96.72), null);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("a resolved zone comes back as its IANA id", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ status: "OK", timeZoneId: "America/Mexico_City" }), { status: 200 }),
  );

  assert.equal(await timezoneForCoordinates(17.06, -96.72), "America/Mexico_City");
  clearEnv();
});

test("a zone id Intl doesn't recognise is treated as no answer", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ status: "OK", timeZoneId: "Nowhere/Fictional" }), { status: 200 }),
  );

  assert.equal(
    await timezoneForCoordinates(0, 0),
    null,
    "better to fall back than to store something that will throw at format time",
  );
  clearEnv();
});

test("API failures degrade to null instead of throwing", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";

  const httpError = t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
  assert.equal(await timezoneForCoordinates(1, 2), null);
  httpError.mock.restore();

  const statusError = t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ status: "REQUEST_DENIED", errorMessage: "API not enabled" }), { status: 200 }),
  );
  assert.equal(await timezoneForCoordinates(1, 2), null);
  statusError.mock.restore();

  const thrown = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  assert.equal(await timezoneForCoordinates(1, 2), null);
  thrown.mock.restore();

  clearEnv();
});

test("describeTimezone names a zone for people who don't think in IANA ids", () => {
  // Fixed instant so the DST-dependent name is stable.
  const january = new Date("2026-01-15T12:00:00Z");
  assert.match(describeTimezone("America/Mexico_City", january), /Central/);
  assert.match(describeTimezone("Europe/Lisbon", january), /Western European/);
  assert.equal(describeTimezone("Middle/Earth", january), "Middle/Earth", "unknown ids pass through");
});

test("acceptTypedTimezone takes region/city ids and refuses bare abbreviations", () => {
  assert.deepEqual(acceptTypedTimezone("Europe/Lisbon"), { ok: true, id: "Europe/Lisbon" });
  assert.deepEqual(acceptTypedTimezone("  America/Mexico_City "), { ok: true, id: "America/Mexico_City" });
  assert.deepEqual(acceptTypedTimezone("UTC"), { ok: true, id: "UTC" });
  // A legacy region alias still says what the person meant.
  assert.deepEqual(acceptTypedTimezone("US/Eastern"), { ok: true, id: "America/New_York" });

  // This is the trap: Intl happily resolves it, to somewhere that never
  // observes DST, so a New York trip would run an hour off all summer.
  const est = acceptTypedTimezone("EST");
  assert.equal(est.ok, false);
  assert.match(est.ok === false ? est.reason : "", /America\/Panama/);

  const nonsense = acceptTypedTimezone("Middle/Earth");
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.ok === false ? nonsense.reason : "", /isn't a time zone/);

  assert.equal(acceptTypedTimezone("   ").ok, false);
});
