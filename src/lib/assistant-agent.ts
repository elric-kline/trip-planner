import { streamMessagesApi } from "./anthropic.ts";

/**
 * The tool-using conversational loop itself, deliberately kept DB-free (see
 * lib/transport-buffer.ts for the same split's precedent) so it's
 * unit-testable with mocked fetch and fake tool executors, with no
 * database in the loop -- lib/assistant.ts is the DB-backed caller: it
 * builds the trip-specific system prompt, defines what each tool actually
 * does (place search, travel time, pinning an idea), and persists the
 * conversation.
 */

export type AgentTurn = { role: "user" | "assistant"; content: string };

/**
 * A tool definition as Anthropic's `tools` array wants it -- deliberately
 * untyped beyond that: a custom tool is `{name, description, input_schema}`,
 * Anthropic's own server tools (e.g. web_search) look different
 * (`{type, name, max_uses}`), and both can appear in the same array.
 */
export type ToolDefinition = Record<string, unknown>;

/** Keyed by tool name; only ever consulted for *custom* tool_use blocks -- a server tool like web_search never reaches this (see the pause_turn branch below), so it needs no executor entry. */
export type ToolExecutors = Record<string, (input: Record<string, unknown>) => Promise<unknown>>;

export type AgentOutcome = { reply: string } | { error: string };

/**
 * What streamAssistantTurn yields as a turn plays out. `text_delta` is a
 * chunk of the final reply's own text, in order, meant to be appended
 * directly to whatever's rendered so far -- exactly the pieces a plain
 * end_turn reply's text is made of, not a separate summary. `tool_start`
 * fires once a tool call's name is known (before its input has finished
 * streaming in), for a "looking that up..." indicator -- nothing about the
 * call's outcome is available yet at that point. Exactly one of `done`/
 * `error` always ends the sequence.
 */
export type AgentStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "done"; reply: string }
  | { type: "error"; message: string };

/** One content block as accumulated across a streamed round's deltas, before being reshaped back into the `content` array format a non-streaming response (and the next round's request) uses. */
type StreamedBlock = { type: string; text?: string; id?: string; name?: string; inputJson?: string };

const MODEL = "claude-sonnet-5";
const LOG_PREFIX = "[assistant]";
/** A round-trip per tool call, plus the final reply -- generous enough for "search, look up details, check travel time, pin two ideas" in one turn without looping forever on a confused chain. In practice OVERALL_BUDGET_MS below is almost always what cuts a long chain short first. */
const MAX_ROUNDS = 8;
/**
 * A hard wall-clock budget for the *whole* turn, not just one round --
 * comfortably under the ~60s default read/proxy timeout common to reverse
 * proxies and load balancers. Without this, a multi-round tool-use chain
 * could legitimately run for minutes end to end on a slow network, during
 * which a request behind such a proxy gets silently dropped: the Server
 * Action never resolves, and the chat just sits on "Thinking..." with no
 * way to tell the difference between "still working" and "will never come
 * back." Better to give up on our own terms, well before that, with a
 * reply the UI can actually show.
 */
const OVERALL_BUDGET_MS = 50_000;
/**
 * Cap on any single call to Anthropic. Deliberately well under
 * OVERALL_BUDGET_MS: if the network path to Anthropic is actually broken
 * (DNS, egress, TLS -- not just "the model is thinking hard"), a real
 * connection either succeeds within a few seconds or it doesn't happen at
 * all, so there's no point burning most of the whole-turn budget waiting
 * out one doomed attempt -- fail it fast and let the overall-budget check
 * decide whether there's room to try again.
 */
const PER_CALL_TIMEOUT_MS = 20_000;
/** Not worth starting another round if there isn't reasonably enough of the budget left for a real response to come back. */
const MIN_ROUND_TIMEOUT_MS = 8_000;

/**
 * One round's worth of streamed events, reduced down to the same shape a
 * non-streaming response would have had: content blocks in order (text
 * accumulated from its deltas, a tool_use's `input` parsed from its
 * accumulated partial JSON) plus the round's stop_reason. Yields
 * `text_delta` as text arrives and `tool_start` the moment a tool_use
 * block's name is known, same contract as streamAssistantTurn itself.
 *
 * `sawMessageStart` distinguishes a real (if terminated early) response
 * from the request never landing at all -- streamMessagesApi yields
 * nothing in either case, and only the former has anything worth reasoning
 * about (see callMessagesApi's `null` for the equivalent non-streaming
 * signal).
 */
async function* streamOneRound(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): AsyncGenerator<AgentStreamEvent, { content: Record<string, unknown>[]; stopReason?: string; sawMessageStart: boolean }> {
  const blocks = new Map<number, StreamedBlock>();
  let stopReason: string | undefined;
  let sawMessageStart = false;

  for await (const event of streamMessagesApi(apiKey, body, timeoutMs, LOG_PREFIX)) {
    if (event.type === "message_start") {
      sawMessageStart = true;
    } else if (event.type === "content_block_start") {
      const index = event.index as number;
      const contentBlock = event.content_block as Record<string, unknown>;
      const type = contentBlock.type as string;
      blocks.set(index, {
        type,
        text: typeof contentBlock.text === "string" ? contentBlock.text : "",
        id: typeof contentBlock.id === "string" ? contentBlock.id : undefined,
        name: typeof contentBlock.name === "string" ? contentBlock.name : undefined,
        inputJson: "",
      });
      if (type === "tool_use" && typeof contentBlock.name === "string") {
        yield { type: "tool_start", name: contentBlock.name };
      }
    } else if (event.type === "content_block_delta") {
      const index = event.index as number;
      const block = blocks.get(index);
      const delta = event.delta as Record<string, unknown>;
      if (!block) continue;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = (block.text ?? "") + delta.text;
        yield { type: "text_delta", text: delta.text };
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.inputJson = (block.inputJson ?? "") + delta.partial_json;
      }
    } else if (event.type === "message_delta") {
      const delta = event.delta as Record<string, unknown>;
      if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
    }
    // message_stop, ping, content_block_stop, error -- nothing else to do with these.
  }

  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.type === "tool_use") {
        let input: Record<string, unknown> = {};
        try {
          input = block.inputJson ? (JSON.parse(block.inputJson) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        return { type: "tool_use", id: block.id, name: block.name, input };
      }
      if (block.type === "text") return { type: "text", text: block.text ?? "" };
      return { type: block.type }; // server_tool_use and anything else -- passed through as-is
    });

  return { content, stopReason, sawMessageStart };
}

/**
 * Runs one user turn to completion, streaming as it goes: sends
 * `userMessage` (with `history` as prior context) to Claude, yielding
 * `text_delta`s as the reply is written and `tool_start`s as tools are
 * called -- server tools like web_search resume on their own (see the
 * pause_turn branch, same pattern as cuisine-inference.ts's single-tool
 * version, just looped and streamed); custom tools call into `executors`
 * and their result is handed back -- until a final `done`/`error` event,
 * once the model produces a final text reply, the round budget runs out,
 * or the overall time budget runs out (see OVERALL_BUDGET_MS above).
 *
 * `history` is plain prior turns, not the raw tool-call blocks a previous
 * turn's own loop produced -- see schema.ts's assistantMessages doc for why
 * that's enough context for the model to still resolve "pin that one"
 * against its own earlier suggestion.
 *
 * `budgetMs` defaults to OVERALL_BUDGET_MS; only overridden by tests that
 * need to exercise the early-exit path deterministically without actually
 * waiting out the real budget.
 */
export async function* streamAssistantTurn(
  apiKey: string,
  systemPrompt: string,
  history: AgentTurn[],
  userMessage: string,
  tools: ToolDefinition[],
  executors: ToolExecutors,
  budgetMs: number = OVERALL_BUDGET_MS,
): AsyncGenerator<AgentStreamEvent> {
  const messages: Record<string, unknown>[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userMessage },
  ];

  const baseBody = {
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    tools,
  };

  const startedAt = Date.now();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining < MIN_ROUND_TIMEOUT_MS) {
      yield { type: "error", message: "That's taking longer than expected — try asking again, maybe more specifically." };
      return;
    }

    const roundStream = streamOneRound(apiKey, { ...baseBody, messages }, Math.min(PER_CALL_TIMEOUT_MS, remaining));
    let roundResult: { content: Record<string, unknown>[]; stopReason?: string; sawMessageStart: boolean };
    while (true) {
      const step = await roundStream.next();
      if (step.done) {
        roundResult = step.value;
        break;
      }
      yield step.value;
    }
    const { content, stopReason, sawMessageStart } = roundResult;

    if (!sawMessageStart) {
      yield { type: "error", message: "The trip assistant couldn't be reached — try again in a moment." };
      return;
    }
    if (stopReason === "refusal") {
      yield { type: "error", message: "The assistant didn't have a response for that -- try rephrasing." };
      return;
    }

    if (stopReason === "pause_turn") {
      // A server tool (web_search) is still working -- Anthropic resumes it
      // automatically once the prior assistant turn (including its
      // server_tool_use block) is sent back; no tool_result needed here.
      messages.push({ role: "assistant", content });
      continue;
    }

    if (stopReason === "tool_use") {
      messages.push({ role: "assistant", content });
      const toolResults = await Promise.all(
        content
          .filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
            b.type === "tool_use" && Boolean(b.id) && Boolean(b.name),
          )
          .map(async (block) => {
            const executor = executors[block.name];
            let output: unknown;
            if (!executor) {
              output = { error: `No such tool: "${block.name}".` };
            } else {
              try {
                output = await executor(block.input ?? {});
              } catch (err) {
                output = { error: err instanceof Error ? err.message : "That tool failed." };
              }
            }
            return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) };
          }),
      );
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn (or any other terminal reason) -- this is the final answer.
    const text = content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    yield { type: "done", reply: text || "I don't have anything to add there." };
    return;
  }

  yield { type: "error", message: "That took more back-and-forth than expected — try asking again, maybe more specifically." };
}

/**
 * Non-streaming convenience wrapper over streamAssistantTurn, for callers
 * that only want the final outcome (e.g. a script, or a test that doesn't
 * care about incremental delivery) -- drains the stream and discards the
 * `text_delta`/`tool_start` events along the way.
 */
export async function runAssistantTurn(
  apiKey: string,
  systemPrompt: string,
  history: AgentTurn[],
  userMessage: string,
  tools: ToolDefinition[],
  executors: ToolExecutors,
  budgetMs: number = OVERALL_BUDGET_MS,
): Promise<AgentOutcome> {
  for await (const event of streamAssistantTurn(apiKey, systemPrompt, history, userMessage, tools, executors, budgetMs)) {
    if (event.type === "done") return { reply: event.reply };
    if (event.type === "error") return { error: event.message };
  }
  // Unreachable in practice -- streamAssistantTurn always ends on done/error -- but keeps this total.
  return { error: "The trip assistant couldn't be reached — try again in a moment." };
}
