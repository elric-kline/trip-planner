import { test } from "node:test";
import assert from "node:assert/strict";
import { runAssistantTurn, streamAssistantTurn, type AgentStreamEvent, type ToolDefinition, type ToolExecutors } from "./assistant-agent.ts";

/**
 * Builds a fake Anthropic streaming (SSE) response. `chunks` lets a test
 * split a text reply across more than one delta, the way a real stream
 * actually arrives -- most tests don't care and just pass one chunk.
 * `new Response(string, ...)` gives a real ReadableStream body (verified
 * against Node's own fetch/Response globals), so this is read by
 * streamMessagesApi exactly like a real network response would be.
 */
function sseEvent(obj: object): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

type FakeBlock =
  | { type: "text"; chunks: string[] }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function sseResponse(blocks: FakeBlock[], stopReason: string): Response {
  const frames: string[] = [sseEvent({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } })];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      frames.push(sseEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      for (const chunk of block.chunks) {
        frames.push(sseEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } }));
      }
      frames.push(sseEvent({ type: "content_block_stop", index }));
    } else {
      frames.push(
        sseEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }),
      );
      frames.push(
        sseEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }),
      );
      frames.push(sseEvent({ type: "content_block_stop", index }));
    }
  });
  frames.push(sseEvent({ type: "message_delta", delta: { stop_reason: stopReason } }));
  frames.push(sseEvent({ type: "message_stop" }));
  return new Response(frames.join(""), { status: 200 });
}

function textResponse(text: string, stopReason = "end_turn"): Response {
  return sseResponse(text ? [{ type: "text", chunks: [text] }] : [], stopReason);
}

function toolUseResponse(calls: { id: string; name: string; input: Record<string, unknown> }[]): Response {
  return sseResponse(
    calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    "tool_use",
  );
}

async function collect(gen: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const NO_TOOLS: ToolDefinition[] = [];
const NO_EXECUTORS: ToolExecutors = {};

test("a plain end_turn reply with no tool use", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textResponse("Grab-and-go near a walkable area sounds great."));

  const result = await runAssistantTurn("key", "system prompt", [], "any lunch ideas?", NO_TOOLS, NO_EXECUTORS);
  assert.deepEqual(result, { reply: "Grab-and-go near a walkable area sounds great." });
});

test("sends prior history plus the new user message, in order, with the system prompt attached, and asks Anthropic to stream", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string);
    assert.equal(body.system, "SYSTEM");
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply to first" },
      { role: "user", content: "second" },
    ]);
    return textResponse("ok");
  });

  await runAssistantTurn(
    "key",
    "SYSTEM",
    [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply to first" },
    ],
    "second",
    NO_TOOLS,
    NO_EXECUTORS,
  );
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("streamAssistantTurn yields each text delta in order as it arrives, then a final done with the whole reply", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    sseResponse([{ type: "text", chunks: ["Grab-and-go ", "near a walkable ", "area sounds great."] }], "end_turn"),
  );

  const events = await collect(streamAssistantTurn("key", "sys", [], "any lunch ideas?", NO_TOOLS, NO_EXECUTORS));
  assert.deepEqual(events, [
    { type: "text_delta", text: "Grab-and-go " },
    { type: "text_delta", text: "near a walkable " },
    { type: "text_delta", text: "area sounds great." },
    { type: "done", reply: "Grab-and-go near a walkable area sounds great." },
  ]);
});

test("streamAssistantTurn yields a tool_start as soon as a tool call's name is known, before its result comes back", async (t) => {
  const executors: ToolExecutors = { estimate_travel: async () => ({ minutes: 12, mode: "walk" }) };
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    if (fetchMock.mock.calls.length === 0) {
      return toolUseResponse([{ id: "call_1", name: "estimate_travel", input: { fromLat: 1, fromLng: 2, toLat: 3, toLng: 4 } }]);
    }
    void init;
    return textResponse("It's a 12-minute walk.");
  });

  const events = await collect(streamAssistantTurn("key", "sys", [], "how far is that?", NO_TOOLS, executors));
  assert.deepEqual(events, [
    { type: "tool_start", name: "estimate_travel" },
    { type: "text_delta", text: "It's a 12-minute walk." },
    { type: "done", reply: "It's a 12-minute walk." },
  ]);
});

test("a pause_turn (server tool still working) resumes by resending the prior assistant turn, no tool_result", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const call = fetchMock.mock.calls.length;
    if (call === 0) return textResponse("Still searching...", "pause_turn");
    const body = JSON.parse((init as RequestInit).body as string);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].role, "assistant");
    return textResponse("Found some grab-and-go spots.");
  });

  const result = await runAssistantTurn("key", "sys", [], "find lunch", NO_TOOLS, NO_EXECUTORS);
  assert.deepEqual(result, { reply: "Found some grab-and-go spots." });
  assert.equal(fetchMock.mock.calls.length, 2);
});

test("a custom tool_use is executed and its result fed back as a tool_result before the loop continues", async (t) => {
  const executed: Record<string, unknown>[] = [];
  const executors: ToolExecutors = {
    estimate_travel: async (input) => {
      executed.push(input);
      return { minutes: 12, mode: "walk" };
    },
  };

  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const call = fetchMock.mock.calls.length;
    if (call === 0) {
      return toolUseResponse([
        { id: "call_1", name: "estimate_travel", input: { fromLat: 1, fromLng: 2, toLat: 3, toLng: 4 } },
      ]);
    }
    const body = JSON.parse((init as RequestInit).body as string);
    // Third message: the tool_result we fed back, addressed to the right call id.
    const toolResultTurn = body.messages[2];
    assert.equal(toolResultTurn.role, "user");
    assert.equal(toolResultTurn.content[0].type, "tool_result");
    assert.equal(toolResultTurn.content[0].tool_use_id, "call_1");
    assert.deepEqual(JSON.parse(toolResultTurn.content[0].content), { minutes: 12, mode: "walk" });
    return textResponse("It's a 12-minute walk.");
  });

  const result = await runAssistantTurn("key", "sys", [], "how far is that?", NO_TOOLS, executors);
  assert.deepEqual(result, { reply: "It's a 12-minute walk." });
  assert.deepEqual(executed, [{ fromLat: 1, fromLng: 2, toLat: 3, toLng: 4 }]);
});

test("multiple tool_use blocks in one response are all executed and each gets its own tool_result", async (t) => {
  const executors: ToolExecutors = {
    pin_idea: async (input) => ({ pinned: input.title }),
  };

  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    if (fetchMock.mock.calls.length === 0) {
      return toolUseResponse([
        { id: "a", name: "pin_idea", input: { title: "Pike Place stop" } },
        { id: "b", name: "pin_idea", input: { title: "Waterfront walk" } },
      ]);
    }
    const body = JSON.parse((init as RequestInit).body as string);
    const results = body.messages[2].content;
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r: { tool_use_id: string }) => r.tool_use_id).sort(),
      ["a", "b"],
    );
    return textResponse("Pinned both.");
  });

  const result = await runAssistantTurn("key", "sys", [], "pin those two", NO_TOOLS, executors);
  assert.deepEqual(result, { reply: "Pinned both." });
});

test("an unknown tool name degrades to an error tool_result instead of crashing the loop", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    if (fetchMock.mock.calls.length === 0) {
      return toolUseResponse([{ id: "x", name: "not_a_real_tool", input: {} }]);
    }
    const body = JSON.parse((init as RequestInit).body as string);
    const content = JSON.parse(body.messages[2].content[0].content);
    assert.match(content.error, /No such tool/);
    return textResponse("Let me try something else.");
  });

  const result = await runAssistantTurn("key", "sys", [], "do the thing", NO_TOOLS, {});
  assert.deepEqual(result, { reply: "Let me try something else." });
});

test("an executor that throws degrades to an error tool_result instead of crashing the loop", async (t) => {
  const executors: ToolExecutors = {
    search_places: async () => {
      throw new Error("Google is down");
    },
  };

  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    if (fetchMock.mock.calls.length === 0) {
      return toolUseResponse([{ id: "x", name: "search_places", input: { query: "lunch" } }]);
    }
    const body = JSON.parse((init as RequestInit).body as string);
    const content = JSON.parse(body.messages[2].content[0].content);
    assert.equal(content.error, "Google is down");
    return textResponse("Couldn't search right now.");
  });

  const result = await runAssistantTurn("key", "sys", [], "find lunch", NO_TOOLS, executors);
  assert.deepEqual(result, { reply: "Couldn't search right now." });
});

test("a refusal returns an error outcome", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textResponse("", "refusal"));

  const result = await runAssistantTurn("key", "sys", [], "anything", NO_TOOLS, NO_EXECUTORS);
  assert.ok("error" in result);
});

test("a network failure returns an error outcome instead of throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });

  const result = await runAssistantTurn("key", "sys", [], "anything", NO_TOOLS, NO_EXECUTORS);
  assert.ok("error" in result);
});

test("a response that never really lands (no message_start at all) is treated as unreachable, not a silent empty reply", async (t) => {
  // A stream that opens but sends nothing recognizable back -- e.g. a proxy
  // that returns 200 with an empty body instead of erroring outright.
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));

  const result = await runAssistantTurn("key", "sys", [], "anything", NO_TOOLS, NO_EXECUTORS);
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /couldn't be reached/);
});

test("a tool loop that never reaches a terminal reply gives up after the round budget instead of looping forever", async (t) => {
  const executors: ToolExecutors = { loopy: async () => ({ ok: true }) };
  t.mock.method(globalThis, "fetch", async () => toolUseResponse([{ id: "x", name: "loopy", input: {} }]));

  const result = await runAssistantTurn("key", "sys", [], "loop forever", NO_TOOLS, executors);
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /more back-and-forth/);
});

test("gives up before even calling out if the time budget is already exhausted going in", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("should never be called -- the budget check should short-circuit first");
  });

  const result = await runAssistantTurn("key", "sys", [], "anything", NO_TOOLS, NO_EXECUTORS, 1_000);
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /taking longer than expected/);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("gives up gracefully once the overall time budget runs out mid-loop, instead of grinding through every remaining round on a slow network", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const executors: ToolExecutors = { loopy: async () => ({ ok: true }) };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    t.mock.timers.tick(20_000); // simulate each round eating a real 20s of a flaky network
    return toolUseResponse([{ id: "x", name: "loopy", input: {} }]);
  });

  const result = await runAssistantTurn("key", "sys", [], "loop forever", NO_TOOLS, executors, 45_000);
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /taking longer than expected/);
  // 45s budget, 8s minimum-per-round floor: round 1 (0->20s) and round 2
  // (20->40s) both clear the floor; round 3 would start with only 5s left,
  // so it gives up there instead of firing a third request.
  assert.equal(fetchMock.mock.calls.length, 2);
});

test("an empty final reply still returns something rather than blank text", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textResponse(""));

  const result = await runAssistantTurn("key", "sys", [], "...", NO_TOOLS, NO_EXECUTORS);
  assert.ok("reply" in result);
  assert.ok((result as { reply: string }).reply.length > 0);
});
