import { callMessagesApi, textOf, type AnthropicContentBlock } from "./anthropic.ts";

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

const MODEL = "claude-sonnet-5";
const LOG_PREFIX = "[assistant]";
/** A round-trip per tool call, plus the final reply -- generous enough for "search, look up details, check travel time, pin two ideas" in one turn without looping forever on a confused chain. In practice OVERALL_BUDGET_MS below is almost always what cuts a long chain short first. */
const MAX_ROUNDS = 8;
/**
 * A hard wall-clock budget for the *whole* turn, not just one round --
 * comfortably under the ~60s default read/proxy timeout common to reverse
 * proxies and load balancers. Without this, a multi-round tool-use chain
 * (each round individually capped at 45s -- see the per-call timeout
 * below) could legitimately run for minutes on a slow/flaky network,
 * during which a request behind such a proxy gets silently dropped: the
 * Server Action never resolves, and the chat just sits on "Thinking..."
 * with no way to tell the difference between "still working" and "will
 * never come back." Better to give up on our own terms, well before that,
 * with a reply the UI can actually show.
 */
const OVERALL_BUDGET_MS = 50_000;
/** Not worth starting another round if there isn't reasonably enough of the budget left for a real response to come back. */
const MIN_ROUND_TIMEOUT_MS = 8_000;

/**
 * Runs one user turn to completion: sends `userMessage` (with `history` as
 * prior context) to Claude, executing whatever tools it calls -- server
 * tools like web_search resume on their own (see the pause_turn branch,
 * same pattern as cuisine-inference.ts's single-tool version, just looped);
 * custom tools call into `executors` and their result is handed back --
 * until it produces a final text reply, the round budget runs out, or the
 * overall time budget runs out (see OVERALL_BUDGET_MS above).
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
export async function runAssistantTurn(
  apiKey: string,
  systemPrompt: string,
  history: AgentTurn[],
  userMessage: string,
  tools: ToolDefinition[],
  executors: ToolExecutors,
  budgetMs: number = OVERALL_BUDGET_MS,
): Promise<AgentOutcome> {
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
      return { error: "That's taking longer than expected — try asking again, maybe more specifically." };
    }

    const response = await callMessagesApi(apiKey, { ...baseBody, messages }, Math.min(45000, remaining), LOG_PREFIX);
    if (!response) return { error: "The trip assistant couldn't be reached — try again in a moment." };
    if (response.stop_reason === "refusal") {
      return { error: "The assistant didn't have a response for that -- try rephrasing." };
    }

    if (response.stop_reason === "pause_turn") {
      // A server tool (web_search) is still working -- Anthropic resumes it
      // automatically once the prior assistant turn (including its
      // server_tool_use block) is sent back; no tool_result needed here.
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolResults = await Promise.all(
        (response.content ?? [])
          .filter((b): b is AnthropicContentBlock & { id: string; name: string } => b.type === "tool_use" && Boolean(b.id) && Boolean(b.name))
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
    const text = textOf(response);
    return { reply: text || "I don't have anything to add there." };
  }

  return { error: "That took more back-and-forth than expected — try asking again, maybe more specifically." };
}
