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
