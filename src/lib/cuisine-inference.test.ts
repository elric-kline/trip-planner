import { test } from "node:test";
import assert from "node:assert/strict";
import { inferCuisineAndDietary } from "./cuisine-inference.ts";

function clearEnv() {
  delete process.env.ANTHROPIC_API_KEY;
}

function textResponse(text: string, stop_reason = "end_turn") {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }], stop_reason }),
    { status: 200 },
  );
}

test("with no API key configured, skips the lookup and returns null", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.equal(result, null);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("a blank name never reaches the network, key or not", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called for a blank name");
  });

  assert.equal(await inferCuisineAndDietary("", "Tokyo"), null);
  assert.equal(await inferCuisineAndDietary("   ", null), null);
  assert.equal(fetchMock.mock.calls.length, 0);
  clearEnv();
});

test("a network failure on the research call degrades to null instead of throwing", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.equal(result, null);
  clearEnv();
});

test("a non-OK HTTP response on the research call degrades to null", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.equal(result, null);
  clearEnv();
});

test("a refusal on the research call returns null without calling the extraction endpoint", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => textResponse("", "refusal"),
  );
  const warnMock = t.mock.method(console, "warn", () => {});

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.equal(result, null);
  assert.equal(fetchMock.mock.calls.length, 1);
  const logged = warnMock.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /refused/);
  clearEnv();
});

test("a refusal on the extraction call returns null even though research succeeded", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call++;
    if (call === 1) return textResponse("Neapolitan pizza, no confirmed dietary accommodations.");
    return textResponse("", "refusal");
  });

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.equal(result, null);
  clearEnv();
});

test("malformed JSON from the extraction call returns null instead of throwing", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call++;
    if (call === 1) return textResponse("Neapolitan pizza.");
    return textResponse("not valid json {{{");
  });
  const warnMock = t.mock.method(console, "warn", () => {});

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.equal(result, null);
  const logged = warnMock.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(logged, /wasn't valid JSON/);
  clearEnv();
});

test("unknown dietary tags from the model are filtered out rather than trusted blindly", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call++;
    if (call === 1) return textResponse("Neapolitan pizza, vegetarian and gluten free options.");
    return textResponse(
      JSON.stringify({
        cuisine: "Neapolitan pizza",
        accommodates: ["vegetarian", "gluten_free", "made_up_tag", 42],
        summary: "Menu explicitly lists vegetarian and gluten-free pizzas.",
      }),
    );
  });

  const result = await inferCuisineAndDietary("Pizzeria Bianco", "Phoenix");
  assert.deepEqual(result, {
    cuisine: "Neapolitan pizza",
    accommodates: ["vegetarian", "gluten_free"],
    summary: "Menu explicitly lists vegetarian and gluten-free pizzas.",
  });
  clearEnv();
});

test("a full successful two-call flow: research then structured extraction", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown, init: unknown) => {
    const call = fetchMock.mock.calls.length;
    const body = JSON.parse((init as RequestInit).body as string);
    if (call === 0) {
      assert.equal(body.model, "claude-opus-5");
      assert.ok(Array.isArray(body.tools));
      assert.equal(body.tools[0].type, "web_search_20260209");
      assert.match(body.messages[0].content, /Sushi Saito, Tokyo/);
      return textResponse("Sushi Saito is a high-end sushi omakase restaurant in Tokyo.");
    }
    assert.equal(body.model, "claude-opus-5");
    assert.equal(body.output_config.format.type, "json_schema");
    return textResponse(
      JSON.stringify({ cuisine: "Sushi omakase", accommodates: [], summary: "No dietary info found." }),
    );
  });

  const result = await inferCuisineAndDietary("Sushi Saito", "Tokyo");
  assert.deepEqual(result, { cuisine: "Sushi omakase", accommodates: [], summary: "No dietary info found." });
  assert.equal(fetchMock.mock.calls.length, 2);
  clearEnv();
});

test("a pause_turn on the research call resumes once by resending prior content, then returns the resumed result", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown, init: unknown) => {
    const call = fetchMock.mock.calls.length;
    if (call === 0) {
      return textResponse("Still searching...", "pause_turn");
    }
    if (call === 1) {
      const body = JSON.parse((init as RequestInit).body as string);
      // The resumed call should carry the prior assistant turn, not a new user message.
      assert.equal(body.messages.length, 2);
      assert.equal(body.messages[1].role, "assistant");
      return textResponse("Found it: Neapolitan pizza.");
    }
    return textResponse(JSON.stringify({ cuisine: "Neapolitan pizza", accommodates: [], summary: null }));
  });

  const result = await inferCuisineAndDietary("Pizzeria Bianco", "Phoenix");
  assert.deepEqual(result, { cuisine: "Neapolitan pizza", accommodates: [], summary: null });
  assert.equal(fetchMock.mock.calls.length, 3);
  clearEnv();
});
