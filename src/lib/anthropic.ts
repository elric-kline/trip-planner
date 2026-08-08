/**
 * Shared plumbing for calling Anthropic's Messages API directly via
 * `fetch` -- see cuisine-inference.ts's doc comment for why not the SDK
 * (one call, no extra dependency to track, mockable the same way every
 * other external call in this app is tested). Every caller decides what to
 * ask for and what to do with the answer; this is just the HTTP request/
 * response boilerplate and failure handling they'd otherwise each
 * duplicate -- a missing/bad response always degrades to null rather than
 * throwing, same posture as every other external integration here.
 */
const MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Only the fields callers here actually read. A tool-using response's
 * content also carries `tool_use`/`server_tool_use`/`tool_result` blocks
 * beyond plain `text` -- those pass straight through in `content` for the
 * caller to inspect (see assistant-agent.ts), this type just doesn't try
 * to enumerate every block shape Anthropic might ever send.
 */
export type AnthropicContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};
export type AnthropicMessageResponse = {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
};

export async function callMessagesApi(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  logPrefix: string,
): Promise<AnthropicMessageResponse | null> {
  let response: Response;
  try {
    response = await fetch(MESSAGES_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.warn(`${logPrefix} request failed:`, err);
    return null;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.warn(`${logPrefix} Anthropic API returned HTTP ${response.status}: ${errBody}`);
    return null;
  }

  return (await response.json()) as AnthropicMessageResponse;
}

/** Concatenates every plain-text block -- a tool-using response typically mixes text with tool_use blocks, and this is only ever what a caller wants to show a human. */
export function textOf(response: AnthropicMessageResponse): string {
  return (response.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * One parsed `data: {...}` frame from a streamed (`stream: true`) Messages
 * API response -- deliberately loose (same posture as AnthropicMessageResponse
 * above: only `type` is guaranteed, callers narrow the rest themselves) since
 * the event shapes differ a lot by `type` (message_start, content_block_start,
 * content_block_delta, message_delta, message_stop, error, ...) and nothing
 * here needs to model all of them, just pass them through.
 */
export type AnthropicStreamEvent = { type: string; [key: string]: unknown };

/**
 * Same request as callMessagesApi, but with `stream: true` forced on, and
 * yielding each parsed SSE event as it arrives instead of waiting for the
 * whole response. A network failure or non-OK response logs the same way
 * callMessagesApi does and simply yields nothing -- callers distinguish
 * "nothing came back" from "a real, empty stream" the same way they'd
 * distinguish callMessagesApi returning null: no events at all (in
 * particular no message_start) means the request never really landed.
 *
 * SSE framing: events are separated by a blank line; only the `data:` line
 * within each frame matters here (Anthropic doesn't rely on the `event:`
 * line's value for anything a caller needs -- the parsed payload's own
 * `type` field is the same information). A malformed individual frame is
 * skipped rather than aborting the whole stream -- one bad chunk shouldn't
 * throw away everything already received.
 */
export async function* streamMessagesApi(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  logPrefix: string,
): AsyncGenerator<AnthropicStreamEvent> {
  let response: Response;
  try {
    response = await fetch(MESSAGES_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.warn(`${logPrefix} request failed:`, err);
    return;
  }

  if (!response.ok || !response.body) {
    const errBody = await response.text().catch(() => "");
    console.warn(`${logPrefix} Anthropic API returned HTTP ${response.status}: ${errBody}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        try {
          yield JSON.parse(json) as AnthropicStreamEvent;
        } catch (err) {
          console.warn(`${logPrefix} skipped a malformed stream frame:`, err);
        }
      }
    }
  } catch (err) {
    console.warn(`${logPrefix} stream read failed:`, err);
  }
}
