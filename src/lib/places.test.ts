import { test } from "node:test";
import assert from "node:assert/strict";
import { autocompleteAddress } from "./places.ts";

function clearEnv() {
  delete process.env.GOOGLE_MAPS_API_KEY;
}

test("with no API key configured, returns no suggestions and never calls fetch", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  const result = await autocompleteAddress("123 Main St");
  assert.deepEqual(result, []);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("queries under the minimum length never reach the network, key or not", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called for a too-short query");
  });

  assert.deepEqual(await autocompleteAddress(""), []);
  assert.deepEqual(await autocompleteAddress("ab"), []);
  assert.equal(fetchMock.mock.calls.length, 0);
  clearEnv();
});

test("a successful lookup maps predictions to {description, placeId} and passes the key + query through", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          predictions: [
            { description: "1600 Amphitheatre Pkwy, Mountain View, CA, USA", place_id: "place_1" },
            { description: "1600 Amphitheatre Pkwy, Palo Alto, CA, USA", place_id: "place_2" },
          ],
        }),
        { status: 200 },
      ),
  );

  const result = await autocompleteAddress("1600 Amphitheatre");
  assert.deepEqual(result, [
    { description: "1600 Amphitheatre Pkwy, Mountain View, CA, USA", placeId: "place_1" },
    { description: "1600 Amphitheatre Pkwy, Palo Alto, CA, USA", placeId: "place_2" },
  ]);

  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.match(url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/place\/autocomplete\/json\?/);
  assert.match(url, /input=1600%20Amphitheatre/);
  assert.match(url, /key=test_key/);
  clearEnv();
});

test("predictions missing a description or place_id are dropped, not crashed on", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          predictions: [
            { description: "Complete Ave", place_id: "place_ok" },
            { description: "Missing place_id Ave" },
            { place_id: "place_missing_description" },
          ],
        }),
        { status: 200 },
      ),
  );

  const result = await autocompleteAddress("Ave");
  assert.deepEqual(result, [{ description: "Complete Ave", placeId: "place_ok" }]);
  clearEnv();
});

test("ZERO_RESULTS resolves to an empty list quietly, not an error", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ status: "ZERO_RESULTS" }), { status: 200 }),
  );

  assert.deepEqual(await autocompleteAddress("asdkfjaslkdfj"), []);
  clearEnv();
});

test("a non-OK HTTP response degrades to an empty list instead of throwing", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

  assert.deepEqual(await autocompleteAddress("somewhere"), []);
  clearEnv();
});

test("a network failure degrades to an empty list instead of throwing", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });

  assert.deepEqual(await autocompleteAddress("somewhere"), []);
  clearEnv();
});

test("REQUEST_DENIED (e.g. a bad key) degrades to an empty list instead of throwing", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "bad_key";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "bad key" }), {
        status: 200,
      }),
  );

  assert.deepEqual(await autocompleteAddress("somewhere"), []);
  clearEnv();
});
