import { test } from "node:test";
import assert from "node:assert/strict";
import { streamMessagesApi, type AnthropicStreamEvent } from "./anthropic.ts";

async function collect(gen: AsyncGenerator<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("streamMessagesApi yields each parsed SSE frame in order, and forces stream:true onto the request body", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string);
    assert.equal(body.stream, true);
    assert.equal(body.model, "x"); // the caller's own body fields still pass through
    const frames = [
      `data: ${JSON.stringify({ type: "message_start" })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    return new Response(frames.join(""), { status: 200 });
  });

  const events = await collect(streamMessagesApi("key", { model: "x" }, 5000, "[test]"));
  assert.deepEqual(events, [
    { type: "message_start" },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "message_stop" },
  ]);
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("a frame split across multiple read() chunks is still reassembled correctly", async (t) => {
  const full = `data: ${JSON.stringify({ type: "message_start" })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  // Split mid-frame, not conveniently on a "\n\n" boundary.
  const splitAt = full.indexOf('"message_start"') + 5;
  const first = full.slice(0, splitAt);
  const second = full.slice(splitAt);

  t.mock.method(globalThis, "fetch", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        controller.enqueue(new TextEncoder().encode(second));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  });

  const events = await collect(streamMessagesApi("key", {}, 5000, "[test]"));
  assert.deepEqual(events, [{ type: "message_start" }, { type: "message_stop" }]);
});

test("a malformed frame is skipped without aborting the rest of the stream", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "message_start" })}\n\n`,
      `data: {not valid json\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    return new Response(frames.join(""), { status: 200 });
  });

  const events = await collect(streamMessagesApi("key", {}, 5000, "[test]"));
  assert.deepEqual(events, [{ type: "message_start" }, { type: "message_stop" }]);
});

test("a non-OK HTTP response yields nothing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("rate limited", { status: 429 }));

  const events = await collect(streamMessagesApi("key", {}, 5000, "[test]"));
  assert.deepEqual(events, []);
});

test("a network failure yields nothing rather than throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });

  const events = await collect(streamMessagesApi("key", {}, 5000, "[test]"));
  assert.deepEqual(events, []);
});
