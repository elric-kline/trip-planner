import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAssistantHistory,
  clearAssistantHistory,
  sendAssistantMessage,
  streamAssistantMessage,
  type AssistantStreamEvent,
} from "./assistant.ts";
import { RuleError, createItem, lockItem, scheduleItem, setRsvp } from "./items.ts";
import { listItems, requireTripAccess } from "./scope.ts";
import { addLocation, listDays, setLocationMembers } from "./days.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";
import { displayName } from "./display-name.ts";

function clearEnv() {
  delete process.env.ANTHROPIC_API_KEY;
}

/**
 * assistant.ts talks to Anthropic via streamAssistantTurn now (see
 * assistant-agent.ts), which always requests `stream: true` -- these build
 * a fake SSE response, same approach as assistant-agent.test.ts's own
 * helpers, since a plain one-shot JSON Response no longer matches what
 * streamMessagesApi reads.
 */
function sseEvent(obj: object): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function textResponse(text: string, stop_reason = "end_turn") {
  const frames = [sseEvent({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } })];
  if (text) {
    frames.push(
      sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
      sseEvent({ type: "content_block_stop", index: 0 }),
    );
  }
  frames.push(sseEvent({ type: "message_delta", delta: { stop_reason } }), sseEvent({ type: "message_stop" }));
  return new Response(frames.join(""), { status: 200 });
}

function toolUseResponse(calls: { id: string; name: string; input: Record<string, unknown> }[]) {
  const frames = [sseEvent({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } })];
  calls.forEach((c, index) => {
    frames.push(
      sseEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } }),
      sseEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } }),
      sseEvent({ type: "content_block_stop", index }),
    );
  });
  frames.push(sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }), sseEvent({ type: "message_stop" }));
  return new Response(frames.join(""), { status: 200 });
}

async function setupTrip() {
  // Named, unlike most fixtures here: several of these tests assert on how the
  // system prompt refers to people, and a nameless user only exercises
  // displayName's fallback (which display-name.test.ts covers directly). Real
  // names are what the prompt carries in production.
  const planner = await createTestUser({ name: "Ana Planner" });
  const memberA = await createTestUser({ name: "Bern Member" });
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, memberA.id, "participant");
  const plannerAccess = await requireTripAccess(trip.id, planner);
  const memberAAccess = await requireTripAccess(trip.id, memberA);
  return { trip, userIds: [planner.id, memberA.id], planner, memberA, plannerAccess, memberAAccess };
}

test("getAssistantHistory is empty until a message is sent; sendAssistantMessage persists both turns in order", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  assert.deepEqual(await getAssistantHistory(plannerAccess), []);

  process.env.ANTHROPIC_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => textResponse("Sure, here are a few ideas."));

  const result = await sendAssistantMessage(plannerAccess, "any lunch ideas?");
  assert.equal(result.reply, "Sure, here are a few ideas.");
  assert.deepEqual(result.pinned, []);

  const history = await getAssistantHistory(plannerAccess);
  assert.deepEqual(history, [
    { role: "user", content: "any lunch ideas?" },
    { role: "assistant", content: "Sure, here are a few ideas." },
  ]);
});

test("sendAssistantMessage rejects a blank message without saving anything or touching the network", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));

  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called for a blank message");
  });

  await assert.rejects(() => sendAssistantMessage(plannerAccess, "   "), RuleError);
  assert.deepEqual(await getAssistantHistory(plannerAccess), []);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("with no ANTHROPIC_API_KEY, the user's message is still saved and a configuration-notice reply is persisted, without calling the network", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => cleanupTrip(trip.id, userIds));
  clearEnv();

  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  const result = await sendAssistantMessage(plannerAccess, "hello?");
  assert.match(result.reply, /isn't configured/);
  assert.equal(fetchMock.mock.calls.length, 0);

  const history = await getAssistantHistory(plannerAccess);
  assert.equal(history.length, 2);
  assert.equal(history[0].content, "hello?");
  assert.match(history[1].content, /isn't configured/);
});

test("clearAssistantHistory only clears the caller's own thread, not another member's", async (t) => {
  const { trip, userIds, plannerAccess, memberAAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => textResponse("ok"));

  await sendAssistantMessage(plannerAccess, "planner's message");
  await sendAssistantMessage(memberAAccess, "member's message");

  await clearAssistantHistory(plannerAccess);
  assert.deepEqual(await getAssistantHistory(plannerAccess), []);
  assert.equal((await getAssistantHistory(memberAAccess)).length, 2);
});

test("history is replayed as prior context on the next message, so the model could resolve a reference to its own earlier suggestion", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  let lastBody: Record<string, unknown> = {};
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    lastBody = JSON.parse((init as RequestInit).body as string);
    return textResponse("noted");
  });

  await sendAssistantMessage(plannerAccess, "first message");
  await sendAssistantMessage(plannerAccess, "pin that one");

  assert.equal(fetchMock.mock.calls.length, 2);
  const messages = lastBody.messages as { role: string; content: string }[];
  assert.deepEqual(messages, [
    { role: "user", content: "first message" },
    { role: "assistant", content: "noted" },
    { role: "user", content: "pin that one" },
  ]);
});

test("the system prompt reflects the locked plan, including who's attending an optional item", async (t) => {
  const { trip, userIds, planner, memberA, plannerAccess, memberAAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  const requiredProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "Flight to Testville", category: "transport" })).id,
    new Date("2026-09-01T08:00:00Z"),
    null,
  );
  await lockItem(plannerAccess, requiredProposed.id, "required");

  const optionalProposed = await scheduleItem(
    plannerAccess,
    (await createItem(plannerAccess, { title: "City tour" })).id,
    new Date("2026-09-02T09:00:00Z"),
    null,
  );
  const optional = await lockItem(plannerAccess, optionalProposed.id, "optional");
  await setRsvp(memberAAccess, optional.id, "yes");

  process.env.ANTHROPIC_API_KEY = "test_key";
  let systemPrompt = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string);
    systemPrompt = body.system;
    return textResponse("ok");
  });

  await sendAssistantMessage(plannerAccess, "what's the plan?");

  assert.match(systemPrompt, /Flight to Testville/);
  assert.match(systemPrompt, /required — everyone attending/);
  assert.match(systemPrompt, new RegExp(`City tour.*attending: ${displayName(memberA)}`));
  assert.doesNotMatch(systemPrompt, new RegExp(`attending: [^\\n]*${displayName(planner)}`));
});

test("the system prompt reflects the day-by-day wake/stop/sleep locations, including a split day's per-person legs, not just the trip's overall destination", async (t) => {
  const { trip, userIds, memberA, plannerAccess, memberAAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  const days = await listDays(plannerAccess); // trip spans 2026-01-01..2026-01-05, see test-fixtures.ts
  const [day1, day2] = days;

  // Day 1: everyone wakes in Seattle, then sleeps in Vancouver -- a
  // multi-city trip whose overall destination field says only "Testville".
  await addLocation(plannerAccess, day1.id, "wake", { name: "Seattle, WA" });
  await addLocation(plannerAccess, day1.id, "sleep", { name: "Vancouver, BC" });

  // Day 2: a split -- the planner wakes in Vancouver, memberA wakes
  // separately in Whistler.
  const vancouverWake = await addLocation(plannerAccess, day2.id, "wake", { name: "Vancouver, BC" });
  await setLocationMembers(plannerAccess, vancouverWake.id, [plannerAccess.viewer.id]);
  const whistlerWake = await addLocation(plannerAccess, day2.id, "wake", { name: "Whistler, BC" });
  await setLocationMembers(plannerAccess, whistlerWake.id, [memberA.id]);

  process.env.ANTHROPIC_API_KEY = "test_key";
  let systemPrompt = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string);
    systemPrompt = body.system;
    return textResponse("ok");
  });

  await sendAssistantMessage(plannerAccess, "what time's sunset our first day?");

  assert.match(systemPrompt, /DAY-BY-DAY LOCATIONS/);
  assert.match(systemPrompt, /Thu, Jan 1: wakes in Seattle, WA; sleeps in Vancouver, BC/);
  assert.match(systemPrompt, /Fri, Jan 2: wakes in Vancouver, BC \([^)]*\) \/ Whistler, BC \([^)]*\)/);
  // Days with nothing entered (Jan 3-5) shouldn't show up as noise.
  assert.doesNotMatch(systemPrompt, /Jan 3/);

  // Same context from the other member's own thread, resolved to *their* name in the split.
  systemPrompt = "";
  await sendAssistantMessage(memberAAccess, "where do I wake up on day 2?");
  assert.match(systemPrompt, new RegExp(`Whistler, BC \\(${displayName(memberA)}\\)`));
});

test("a pin_idea tool call creates a private Scratchpad idea and is reported back in the pinned list", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    if (fetchMock.mock.calls.length === 0) {
      return toolUseResponse([
        {
          id: "call_1",
          name: "pin_idea",
          input: { title: "Grab-and-go: Pike Place Chowder", category: "dining", lat: 47.6, lng: -122.34 },
        },
      ]);
    }
    return textResponse("Pinned it to your Scratchpad.");
  });

  const result = await sendAssistantMessage(plannerAccess, "pin that one");
  assert.equal(result.reply, "Pinned it to your Scratchpad.");
  assert.equal(result.pinned.length, 1);
  assert.equal(result.pinned[0].title, "Grab-and-go: Pike Place Chowder");
  assert.equal(result.pinned[0].visibility, "private");
  assert.equal(result.pinned[0].status, "idea");

  const items = await listItems(plannerAccess);
  const created = items.find((i) => i.id === result.pinned[0].id);
  assert.ok(created);
  assert.equal(created?.locationLat, 47.6);
});

test("estimate_travel and search_places tool calls run and feed their results back without crashing the loop, even with no Places API key configured", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    delete process.env.GOOGLE_MAPS_API_KEY;
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  delete process.env.GOOGLE_MAPS_API_KEY;

  const fetchMock = t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (typeof url === "string" && url.includes("maps.googleapis.com")) {
      throw new Error("Places should not be reached without a key -- places.ts itself should short-circuit");
    }
    const call = fetchMock.mock.calls.length;
    if (call === 0) {
      return toolUseResponse([
        { id: "a", name: "search_places", input: { query: "grab and go lunch" } },
        { id: "b", name: "estimate_travel", input: { fromLat: 47.45, fromLng: -122.31, toLat: 47.6, toLng: -122.33 } },
      ]);
    }
    return textResponse("Here's what I found.");
  });

  const result = await sendAssistantMessage(plannerAccess, "find lunch near the airport");
  assert.equal(result.reply, "Here's what I found.");
});

test("tool calls with missing or invalid input degrade to an error result instead of crashing the loop", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  const seen: Record<string, unknown>[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const call = fetchMock.mock.calls.length;
    if (call === 0) {
      return toolUseResponse([
        { id: "a", name: "get_place_details", input: {} }, // no placeId
        { id: "b", name: "estimate_travel", input: { fromLat: "not a number" } }, // missing/invalid coords
        { id: "c", name: "pin_idea", input: { category: "dining" } }, // no title
      ]);
    }
    const body = JSON.parse((init as RequestInit).body as string);
    seen.push(...(body.messages[2].content as Record<string, unknown>[]));
    return textResponse("Got it.");
  });

  const result = await sendAssistantMessage(plannerAccess, "look some stuff up");
  assert.equal(result.reply, "Got it.");
  assert.equal(result.pinned.length, 0);

  const errors = seen.map((r) => JSON.parse(r.content as string).error);
  assert.match(errors[0], /placeId/);
  assert.match(errors[1], /four finite numbers/);
  assert.match(errors[2], /title/);
});

test("streamAssistantMessage yields text deltas as they arrive, then a final done carrying the same reply sendAssistantMessage would persist", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  t.mock.method(globalThis, "fetch", async () => {
    const frames = [
      sseEvent({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }),
      sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sure, " } }),
      sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "here you go." } }),
      sseEvent({ type: "content_block_stop", index: 0 }),
      sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      sseEvent({ type: "message_stop" }),
    ];
    return new Response(frames.join(""), { status: 200 });
  });

  const events: AssistantStreamEvent[] = [];
  for await (const event of streamAssistantMessage(plannerAccess, "any lunch ideas?")) events.push(event);

  assert.deepEqual(events, [
    { type: "text_delta", text: "Sure, " },
    { type: "text_delta", text: "here you go." },
    { type: "done", reply: "Sure, here you go.", pinned: [] },
  ]);

  // Persisted exactly like the non-streaming path -- the point of
  // streaming is delivery, not a different stored conversation.
  assert.deepEqual(await getAssistantHistory(plannerAccess), [
    { role: "user", content: "any lunch ideas?" },
    { role: "assistant", content: "Sure, here you go." },
  ]);
});

test("streamAssistantMessage yields a tool_start for a pin_idea call, and the final done's pinned list is trimmed to id/title", async (t) => {
  const { trip, userIds, plannerAccess } = await setupTrip();
  t.after(() => {
    clearEnv();
    return cleanupTrip(trip.id, userIds);
  });

  process.env.ANTHROPIC_API_KEY = "test_key";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    if (fetchMock.mock.calls.length === 0) {
      return toolUseResponse([{ id: "call_1", name: "pin_idea", input: { title: "Pike Place Chowder", category: "dining" } }]);
    }
    return textResponse("Pinned it.");
  });

  const events: AssistantStreamEvent[] = [];
  for await (const event of streamAssistantMessage(plannerAccess, "pin that one")) events.push(event);

  assert.deepEqual(events[0], { type: "tool_start", name: "pin_idea" });

  const items = await listItems(plannerAccess);
  const created = items.find((i) => i.title === "Pike Place Chowder");
  assert.ok(created, "pin_idea actually created the item");
  assert.equal(created?.visibility, "private");

  const done = events[events.length - 1];
  assert.deepEqual(done, {
    type: "done",
    reply: "Pinned it.",
    pinned: [{ id: created?.id, title: "Pike Place Chowder" }],
  });
});
