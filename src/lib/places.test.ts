import { test } from "node:test";
import assert from "node:assert/strict";
import { autocompleteAddress, searchRestaurants, getPlaceDetails } from "./places.ts";

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
  assert.match(url, /input=1600\+Amphitheatre/);
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

test("REQUEST_DENIED (e.g. a bad key) degrades to an empty list, and logs Google's error_message so it's actually diagnosable", async (t) => {
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

  assert.deepEqual(await autocompleteAddress("somewhere"), []);
  const logged = warnMock.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /REQUEST_DENIED/);
  assert.match(logged, /This API project is not authorized to use this API\./);
  clearEnv();
});

test("searchRestaurants appends the destination to the query and restricts to establishments", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          predictions: [{ description: "Sushi Saito, Tokyo, Japan", place_id: "place_sushi" }],
        }),
        { status: 200 },
      ),
  );

  const result = await searchRestaurants("Sushi Saito", "Tokyo");
  assert.deepEqual(result, [{ description: "Sushi Saito, Tokyo, Japan", placeId: "place_sushi" }]);

  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.match(url, /input=Sushi\+Saito\+Tokyo/);
  assert.match(url, /types=establishment/);
  clearEnv();
});

test("searchRestaurants with no destination still searches, just without appending one", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ status: "ZERO_RESULTS" }), { status: 200 }),
  );

  await searchRestaurants("Sushi Saito", "");
  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.match(url, /input=Sushi\+Saito(&|$)/);
  clearEnv();
});

test("getPlaceDetails with no API key configured returns null and never calls fetch", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  assert.equal(await getPlaceDetails("place_123"), null);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("getPlaceDetails maps a successful response, including a numeric price_level of 0", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          result: {
            name: "Sushi Saito",
            formatted_address: "Roppongi, Tokyo, Japan",
            formatted_phone_number: "+81 3-0000-0000",
            website: "https://sushi-saito.example",
            price_level: 4,
          },
        }),
        { status: 200 },
      ),
  );

  const result = await getPlaceDetails("place_sushi");
  assert.deepEqual(result, {
    name: "Sushi Saito",
    formattedAddress: "Roppongi, Tokyo, Japan",
    phone: "+81 3-0000-0000",
    website: "https://sushi-saito.example",
    priceLevel: 4,
  });

  const [url] = fetchMock.mock.calls[0].arguments as [string];
  assert.match(url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/place\/details\/json\?/);
  assert.match(url, /place_id=place_sushi/);
  assert.match(url, /key=test_key/);
  clearEnv();
});

test("getPlaceDetails fills in nulls for whatever fields Google doesn't return", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ status: "OK", result: { name: "No Frills Diner" } }), { status: 200 }),
  );

  const result = await getPlaceDetails("place_diner");
  assert.deepEqual(result, {
    name: "No Frills Diner",
    formattedAddress: null,
    phone: null,
    website: null,
    priceLevel: null,
  });
  clearEnv();
});

test("getPlaceDetails degrades to null on a non-OK status, HTTP error, or network failure", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "test_key";

  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ status: "NOT_FOUND" }), { status: 200 }),
  );
  assert.equal(await getPlaceDetails("place_gone"), null);

  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
  assert.equal(await getPlaceDetails("place_http_error"), null);

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });
  assert.equal(await getPlaceDetails("place_network_error"), null);

  clearEnv();
});
