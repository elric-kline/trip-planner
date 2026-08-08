import { DIETARY_TAGS, type DietaryTag } from "./dietary.ts";
import { callMessagesApi, textOf } from "./anthropic.ts";

/**
 * Infers a restaurant's cuisine and likely dietary accommodations by having
 * Claude research it on the web -- the piece Google Places genuinely can't
 * give us (see places.ts: Place Details deliberately skips this, since
 * Places' own fields are too coarse to trust silently).
 *
 * Plain `fetch` against the Messages API rather than the `@anthropic-ai/sdk`
 * package -- see anthropic.ts, whose callMessagesApi/textOf this shares
 * with lib/assistant-agent.ts. Two Claude calls, not one: a web-search-
 * enabled research call in plain text, then a separate structured-output
 * call to extract clean JSON from that research. Keeping them apart
 * sidesteps any interaction between the web search tool's automatic
 * citations and output_config.format's own citations restriction, and lets
 * the research call reason freely instead of fighting a schema mid-search.
 *
 * Same failure shape as geocode.ts/places.ts: no key, a bad response, a
 * refusal, or a network error all just return null. This is a "nice to
 * have" suggestion a human still has to confirm (see the UI's "AI-suggested
 * — please verify" framing) -- it should never block saving a dining item.
 */
const MODEL = "claude-opus-5";
const LOG_PREFIX = "[cuisine-inference]";

export type CuisineInference = {
  cuisine: string | null;
  /** What the research found evidence for -- still just a starting point for a human to confirm, same as every other accommodates value in this app. */
  accommodates: DietaryTag[];
  /** The model's own plain-language summary of what it found (or didn't) -- shown to the user alongside the suggestion, not a calibrated confidence score. */
  summary: string | null;
};

/** Web search runs as a server-side tool loop; a long search can pause after many rounds. Resume once, then give up rather than loop indefinitely. */
async function researchRestaurant(apiKey: string, query: string): Promise<string | null> {
  const userMessage = {
    role: "user",
    content: `Research the restaurant "${query}" using web search. Based on its menu, website, and reviews, describe: (1) its cuisine in a few words (e.g. "Neapolitan pizza", "izakaya"), and (2) which of these dietary needs it is known to accommodate, if any: ${DIETARY_TAGS.join(", ")}. Only state an accommodation you found real evidence for in a search result -- do not guess from the restaurant's name or cuisine alone. If you can't find enough information to say anything useful, say so plainly.`,
  };
  const messages: Record<string, unknown>[] = [userMessage];

  const baseBody = {
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: "medium" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
  };

  let response = await callMessagesApi(apiKey, { ...baseBody, messages }, 30000, LOG_PREFIX);
  if (!response) return null;

  // Resume a paused server-tool loop at most once -- the API detects the
  // trailing server_tool_use block on its own; no extra "continue" message.
  for (let i = 0; i < 2 && response.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: response.content });
    response = await callMessagesApi(apiKey, { ...baseBody, messages }, 30000, LOG_PREFIX);
    if (!response) return null;
  }

  if (response.stop_reason === "refusal") {
    console.warn(`${LOG_PREFIX} research call was refused.`);
    return null;
  }

  const text = textOf(response);
  return text || null;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    cuisine: { anyOf: [{ type: "string" }, { type: "null" }] },
    accommodates: { type: "array", items: { type: "string", enum: [...DIETARY_TAGS] } },
    summary: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["cuisine", "accommodates", "summary"],
  additionalProperties: false,
};

async function extractStructured(apiKey: string, research: string): Promise<CuisineInference | null> {
  const response = await callMessagesApi(
    apiKey,
    {
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Extract structured data from this restaurant research. If the research found no reliable evidence for a field, use null (or an empty list for accommodates) rather than guessing.\n\n${research}`,
        },
      ],
    },
    15000,
    LOG_PREFIX,
  );
  if (!response || response.stop_reason === "refusal") return null;

  const text = textOf(response);
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn(`${LOG_PREFIX} extraction response wasn't valid JSON:`, err);
    return null;
  }

  return validate(parsed);
}

/** Structured outputs constrain the model, but we still don't trust a third party's JSON blindly -- same posture as every other external response in this app. */
function validate(value: unknown): CuisineInference | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const cuisine = typeof v.cuisine === "string" ? v.cuisine : null;
  const summary = typeof v.summary === "string" ? v.summary : null;
  const known = new Set<string>(DIETARY_TAGS);
  const accommodates = Array.isArray(v.accommodates)
    ? v.accommodates.filter((tag): tag is DietaryTag => typeof tag === "string" && known.has(tag))
    : [];

  return { cuisine, accommodates, summary };
}

export async function inferCuisineAndDietary(
  name: string,
  address: string | null,
): Promise<CuisineInference | null> {
  const query = name.trim();
  if (!query) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} ANTHROPIC_API_KEY not set — skipping lookup for "${query}".`);
    return null;
  }

  const fullQuery = address ? `${query}, ${address}` : query;

  const research = await researchRestaurant(apiKey, fullQuery);
  if (!research) return null;

  return extractStructured(apiKey, research);
}
