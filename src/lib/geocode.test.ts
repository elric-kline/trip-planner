import { test } from "node:test";
import assert from "node:assert/strict";
import { geocodeAddress } from "./geocode.ts";

function clearEnv() {
  delete process.env.GOOGLE_MAPS_API_KEY;
}

test("with no API key configured, skips the lookup and returns null", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  const result = await geocodeAddress("1600 Amphitheatre Parkway, Mountain View, CA");
  assert.equal(result, null);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("blank input never reaches the network, key or not", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called for blank input");
  });

  assert.equal(await geocodeAddress(""), null);
  assert.equal(await geocodeAddress("   "), null);
  assert.equal(fetchMock.mock.calls.length, 0);
  clearEnv();
});

test("a successful lookup extracts lat/lng and passes the key + query through", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          results: [{ geometry: { location: { lat: 37.422, lng: -122.084 } } }],
        }),
        { status: 200 },
      ),
  );

  const result = await geocodeAddress("1600 Amphitheatre Parkway, Mountain View, CA");
  assert.deepEqual(result, { lat: 37.422, lng: -122.084 });

  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.match(url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode\/json\?/);
  assert.match(url, /address=1600%20Amphitheatre%20Parkway/);
  assert.match(url, /key=test_key/);
  clearEnv();
});

test("ZERO_RESULTS resolves to null quietly, not an error", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ status: "ZERO_RESULTS" }), { status: 200 }),
  );

  const result = await geocodeAddress("asdkfjaslkdfj not a real place");
  assert.equal(result, null);
  clearEnv();
});

test("a non-OK HTTP response degrades to null instead of throwing", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

  const result = await geocodeAddress("somewhere");
  assert.equal(result, null);
  clearEnv();
});

test("a network failure degrades to null instead of throwing", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });

  const result = await geocodeAddress("somewhere");
  assert.equal(result, null);
  clearEnv();
});

test("REQUEST_DENIED (e.g. a bad key) degrades to null, and logs Google's error_message so it's actually diagnosable", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "bad_key";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "REQUEST_DENIED",
          error_message: "This API project is not authorized to use this API.",
        }),
        { status: 200 },
      ),
  );
  const warnMock = t.mock.method(console, "warn", () => {});

  const result = await geocodeAddress("somewhere");
  assert.equal(result, null);
  const logged = warnMock.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /REQUEST_DENIED/);
  assert.match(logged, /This API project is not authorized to use this API\./);
  clearEnv();
});
