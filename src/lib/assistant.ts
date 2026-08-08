import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { assistantMessages } from "@/db/schema";
import { listItems, type Item, type TripAccess } from "./scope.ts";
import { rsvpsForItems } from "./attendance.ts";
import { createItem, RuleError } from "./items.ts";
import { searchRestaurants, getPlaceDetails } from "./places.ts";
import { HaversineTravelTimeProvider, inferMode, type Coordinates } from "./travel.ts";
import { listDays, locationsForDays, locationMembersForLocations, type DayLocationKind, type TripDayLocation } from "./days.ts";
import { formatCalendarDate } from "./time.ts";
import {
  runAssistantTurn,
  streamAssistantTurn,
  type AgentTurn,
  type ToolDefinition,
  type ToolExecutors,
} from "./assistant-agent.ts";

/**
 * The trip assistant: a Scratchpad-scoped chat that has full read access to
 * everything the viewer can already see (their own locked/proposed/idea
 * items, plus the group's shared locked and proposed/idea items and who's
 * attending each) and a small set of tools to ground its suggestions in
 * real places and real travel times, and to save a suggestion as a new
 * Scratchpad idea when asked to "pin" it.
 *
 * Split the way transport-buffer.ts/transport.ts and cuisine-inference.ts/
 * assistant-agent.ts are: the actual conversational loop
 * (assistant-agent.ts) is DB-free and unit-tested with mocked fetch; this
 * module is what talks to the database -- persistence, trip context, and
 * what each tool actually does.
 */

export type AssistantTurn = AgentTurn;

/** Every past turn for this (trip, viewer) thread, oldest first -- what gets replayed as conversation history on the next message. */
export async function getAssistantHistory(access: TripAccess): Promise<AssistantTurn[]> {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(and(eq(assistantMessages.tripId, access.trip.id), eq(assistantMessages.userId, access.viewer.id)))
    .orderBy(asc(assistantMessages.createdAt));
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

async function appendMessage(access: TripAccess, role: "user" | "assistant", content: string): Promise<void> {
  await db.insert(assistantMessages).values({ tripId: access.trip.id, userId: access.viewer.id, role, content });
}

/** "Clear conversation" -- only this viewer's own thread; never touches anyone else's. */
export async function clearAssistantHistory(access: TripAccess): Promise<void> {
  await db
    .delete(assistantMessages)
    .where(and(eq(assistantMessages.tripId, access.trip.id), eq(assistantMessages.userId, access.viewer.id)));
}

function memberName(access: TripAccess, userId: string): string {
  const member = access.members.find((m) => m.userId === userId);
  return member?.name ?? member?.email ?? "someone";
}

function formatItemLine(item: Item, timezone: string): string {
  const tz = item.timezone ?? timezone;
  const when = item.startsAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(item.startsAt)
    : "no time set";
  const where = item.locationName ? ` @ ${item.locationName}` : "";
  return `${when} — ${item.title} [${item.category}]${where}`;
}

/**
 * The locked group plan, each optional item annotated with who's actually
 * in it -- this is what lets the assistant answer "is anyone busy then,"
 * not just "what's on the calendar." Required items need no lookup
 * (everyone's automatically on them); only optional items need their
 * RSVPs, batched in one query rather than one per item.
 */
async function describeLockedGroupItems(access: TripAccess, items: Item[]): Promise<string[]> {
  const optionalIds = items.filter((i) => i.commitment === "optional").map((i) => i.id);
  const rsvps = await rsvpsForItems(optionalIds);
  const rsvpMap = new Map(rsvps.map((r) => [r.itemId, r.responses]));

  return items.map((item) => {
    const line = formatItemLine(item, access.trip.timezone);
    if (item.commitment === "required") return `${line} (required — everyone attending)`;

    const responses = rsvpMap.get(item.id) ?? new Map<string, string>();
    const attending = access.members.filter((m) => responses.get(m.userId) === "yes").map((m) => m.name ?? m.email);
    const declined = access.members.filter((m) => responses.get(m.userId) === "no").map((m) => m.name ?? m.email);
    const bits = [
      attending.length > 0 ? `attending: ${attending.join(", ")}` : null,
      declined.length > 0 ? `not attending: ${declined.join(", ")}` : null,
    ].filter(Boolean);
    return `${line} (optional${bits.length ? " — " + bits.join("; ") : ""})`;
  });
}

/** One kind's locations for a day, rendered as "Place A" or, for a split, "Place A (Sam) / Place B (Alex, Jordan)" -- the member parenthetical is only added when it's not simply everyone, same restraint as describeLockedGroupItems. */
function describeLocationsOfKind(
  access: TripAccess,
  locations: TripDayLocation[],
  membersByLocation: Map<string, string[]>,
): string {
  return locations
    .map((loc) => {
      const memberIds = membersByLocation.get(loc.id) ?? [];
      const everyone = access.members.every((m) => memberIds.includes(m.userId));
      if (everyone) return loc.name;
      const names = memberIds.map((id) => memberName(access, id));
      return `${loc.name} (${names.length > 0 ? names.join(", ") : "no one yet"})`;
    })
    .join(" / ");
}

/** One line per day that actually has a wake/stop/sleep location set -- days with nothing entered yet are left out entirely rather than printed as "nothing planned," which would just be noise. */
function describeDayLine(
  access: TripAccess,
  date: string,
  byKind: Map<DayLocationKind, TripDayLocation[]>,
  membersByLocation: Map<string, string[]>,
): string | null {
  const wake = byKind.get("wake") ?? [];
  const stop = byKind.get("stop") ?? [];
  const sleep = byKind.get("sleep") ?? [];
  if (wake.length === 0 && stop.length === 0 && sleep.length === 0) return null;

  const parts = [
    wake.length > 0 ? `wakes in ${describeLocationsOfKind(access, wake, membersByLocation)}` : null,
    stop.length > 0 ? `stops: ${describeLocationsOfKind(access, stop, membersByLocation)}` : null,
    sleep.length > 0 ? `sleeps in ${describeLocationsOfKind(access, sleep, membersByLocation)}` : null,
  ].filter((p): p is string => Boolean(p));
  return `${formatCalendarDate(date)}: ${parts.join("; ")}`;
}

/**
 * The trip's actual day-by-day geography -- where the group wakes up,
 * passes through, and sleeps each night (see days.ts's tripDayLocations
 * comment for why this is tracked independently of any lodging item's
 * check-in/out). This is what lets the assistant answer "what time's
 * sunset on our first day in Seattle" correctly on a multi-city trip,
 * instead of only knowing the trip's single overall destination field --
 * a Vancouver-titled trip can easily wake its first day in Seattle.
 */
async function describeDayLocations(access: TripAccess): Promise<string[]> {
  const days = await listDays(access);
  const locationsByDay = await locationsForDays(days.map((d) => d.id));
  const allLocationIds = [...locationsByDay.values()].flat().map((l) => l.id);
  const membersByLocation = await locationMembersForLocations(allLocationIds);

  const lines: string[] = [];
  for (const day of days) {
    const byKind = new Map<DayLocationKind, TripDayLocation[]>();
    for (const loc of locationsByDay.get(day.id) ?? []) {
      byKind.set(loc.kind, [...(byKind.get(loc.kind) ?? []), loc]);
    }
    const line = describeDayLine(access, day.date, byKind, membersByLocation);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Rebuilt fresh for every message -- never cached across turns -- so a
 * lock, an RSVP, or a new idea made moments ago is always what the
 * assistant is reasoning about, not a stale snapshot from earlier in the
 * conversation.
 */
async function buildSystemPrompt(access: TripAccess): Promise<string> {
  const items = await listItems(access);
  const locked = items.filter((i) => i.status === "locked");
  const lockedGroup = locked.filter((i) => i.visibility === "group" && i.startsAt);
  const lockedPrivate = locked.filter((i) => i.visibility === "private" && i.startsAt);
  const sharedInPlay = items.filter(
    (i) => i.visibility === "group" && (i.status === "proposed" || i.status === "idea"),
  );
  const myIdeas = items.filter(
    (i) => i.visibility === "private" && (i.status === "proposed" || i.status === "idea"),
  );

  const lockedGroupLines = await describeLockedGroupItems(access, lockedGroup);
  const dayLocationLines = await describeDayLocations(access);
  const tz = access.trip.timezone;

  const sections = [
    `You are the trip assistant for "${access.trip.name}" (${access.trip.destination}, ${access.trip.startDate} to ${access.trip.endDate}, timezone ${tz}). You're chatting with ${memberName(access, access.viewer.id)} in their own Scratchpad -- private brainstorming space only they can see.`,
    `Trip members: ${access.members.map((m) => m.name ?? m.email).join(", ")}.`,
    dayLocationLines.length > 0
      ? `DAY-BY-DAY LOCATIONS (where the group actually wakes up, passes through, and sleeps each night -- this is the real geography to reason from, not just the trip's overall destination above, since a multi-city trip can wake or stop somewhere else entirely on a given day; a "(name, name)" tag means only those people are there, not everyone):\n${dayLocationLines.map((l) => `- ${l}`).join("\n")}`
      : "No day-by-day wake/stop/sleep locations have been entered yet -- the trip's overall destination above is all that's known about where the group is each day.",
    lockedGroupLines.length > 0
      ? `LOCKED PLAN (the group's settled itinerary):\n${lockedGroupLines.map((l) => `- ${l}`).join("\n")}`
      : "Nothing is locked in yet.",
    lockedPrivate.length > 0
      ? `${memberName(access, access.viewer.id)}'S OWN LOCKED PRIVATE PLANS:\n${lockedPrivate.map((i) => `- ${formatItemLine(i, tz)}`).join("\n")}`
      : null,
    sharedInPlay.length > 0
      ? `SHARED IDEAS BEING DISCUSSED (PlaySpace, not locked yet):\n${sharedInPlay.map((i) => `- ${formatItemLine(i, tz)}`).join("\n")}`
      : null,
    myIdeas.length > 0
      ? `${memberName(access, access.viewer.id)}'S OWN PRIVATE IDEAS (Scratchpad, not shared):\n${myIdeas.map((i) => `- ${formatItemLine(i, tz)}`).join("\n")}`
      : null,
    `You have tools to search for real places, look up a specific place's exact address and coordinates, estimate real travel time between two points, and save a suggestion as a new private Scratchpad idea ("pin" it) when asked.

Ground concrete suggestions in real places using the search/details tools rather than inventing a name or address. Before claiming something is close to (or far from) another stop -- the airport, a locked item, another suggestion in this conversation -- use the travel-time tool on their actual coordinates instead of guessing from geography knowledge alone; don't assume two places are near each other just because they're in the same city.

When a question depends on where the group is on a given day (sunset time, weather, "our first day in ___," what's walkable), check DAY-BY-DAY LOCATIONS above rather than assuming the whole trip happens in the overall destination -- multi-city trips wake, stop, or sleep somewhere else entirely on plenty of days. If the day/city someone names genuinely isn't in that list, say so plainly and ask rather than guessing.

When asked to "pin" one or more of your own suggestions, call the pin tool once per item, using the exact place details you already looked up -- never invent coordinates. Confirm what got pinned in plain language afterward.

Keep responses conversational and concise -- this is a back-and-forth chat, not a report.`,
  ];

  return sections.filter((s): s is string => Boolean(s)).join("\n\n");
}

const TOOLS: ToolDefinition[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  {
    name: "search_places",
    description:
      'Search for real, named places (restaurants, cafes, shops, landmarks, neighborhoods) near the trip\'s destination. Returns candidate names and placeIds -- call get_place_details on whichever one you want to use before recommending it as a specific stop or pinning it, since this doesn\'t return an address or coordinates.',
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: 'What to search for, e.g. "grab and go lunch near Pike Place"' } },
      required: ["query"],
    },
  },
  {
    name: "get_place_details",
    description:
      "Look up a specific place's exact address, coordinates, phone, and website by its placeId (from search_places). Always call this before pinning a place or reasoning about its travel time.",
    input_schema: {
      type: "object",
      properties: { placeId: { type: "string" } },
      required: ["placeId"],
    },
  },
  {
    name: "estimate_travel",
    description:
      "Estimate real travel time in minutes between two coordinates (e.g. the airport and a candidate restaurant, or two stops already in the itinerary). Always use this instead of guessing distance/time from place names or general geography knowledge.",
    input_schema: {
      type: "object",
      properties: {
        fromLat: { type: "number" },
        fromLng: { type: "number" },
        toLat: { type: "number" },
        toLng: { type: "number" },
      },
      required: ["fromLat", "fromLng", "toLat", "toLng"],
    },
  },
  {
    name: "pin_idea",
    description:
      "Save a suggestion as a new private idea in the user's own Scratchpad -- unscheduled, visible only to them, not shared with the group. Only use this when the user actually asks to pin/save something, using the real place details already looked up.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        category: { type: "string", enum: ["lodging", "dining", "activity", "transport", "other"] },
        locationName: { type: "string" },
        lat: { type: "number" },
        lng: { type: "number" },
        notes: { type: "string" },
      },
      required: ["title", "category"],
    },
  },
];

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildExecutors(access: TripAccess, pinned: Item[]): ToolExecutors {
  return {
    async search_places(input) {
      const query = asNonEmptyString(input.query);
      if (!query) return { error: "Need a query to search for." };
      const results = await searchRestaurants(query, access.trip.destination);
      return { results: results.map((r) => ({ name: r.description, placeId: r.placeId })) };
    },

    async get_place_details(input) {
      const placeId = asNonEmptyString(input.placeId);
      if (!placeId) return { error: "Need a placeId (from search_places)." };
      const details = await getPlaceDetails(placeId);
      return details ?? { error: "Couldn't look up that place." };
    },

    async estimate_travel(input) {
      const fromLat = asFiniteNumber(input.fromLat);
      const fromLng = asFiniteNumber(input.fromLng);
      const toLat = asFiniteNumber(input.toLat);
      const toLng = asFiniteNumber(input.toLng);
      if (fromLat == null || fromLng == null || toLat == null || toLng == null) {
        return { error: "Need four finite numbers: fromLat, fromLng, toLat, toLng." };
      }
      const from: Coordinates = { lat: fromLat, lng: fromLng };
      const to: Coordinates = { lat: toLat, lng: toLng };
      const mode = inferMode(from, to);
      const estimate = await new HaversineTravelTimeProvider().estimate(from, to, mode);
      return { minutes: estimate.minutes, mode, overheadMinutes: estimate.overheadMinutes };
    },

    async pin_idea(input) {
      const title = asNonEmptyString(input.title);
      if (!title) return { error: "Need a title to pin." };
      const category = (asNonEmptyString(input.category) ?? "other") as Item["category"];
      const locationName = asNonEmptyString(input.locationName);
      const lat = asFiniteNumber(input.lat);
      const lng = asFiniteNumber(input.lng);
      const notes = asNonEmptyString(input.notes);

      try {
        const created = await createItem(access, {
          title,
          category,
          notes,
          locationName,
          locationLat: lat,
          locationLng: lng,
          visibility: "private",
        });
        pinned.push(created);
        return { pinned: { id: created.id, title: created.title } };
      } catch (err) {
        return { error: err instanceof RuleError ? err.message : "Couldn't save that idea." };
      }
    },
  };
}

export type AssistantReply = { reply: string; pinned: Item[] };

/**
 * Sends one message, persists both sides of the exchange (the user's turn
 * is saved even if the model call fails, so a flaky request never silently
 * drops what someone typed), and returns the reply plus whatever got
 * pinned along the way. Anyone on the trip may use their own thread here --
 * no planner/author gate, same as any other Scratchpad activity.
 *
 * Non-streaming: waits for the whole reply before returning. Kept around
 * (rather than only the streaming version below) as a plain async
 * request/response API for anything that doesn't need incremental
 * delivery -- a script, a test, a future non-UI caller. The chat UI itself
 * uses streamAssistantMessage instead; see AssistantChat.tsx.
 */
export async function sendAssistantMessage(access: TripAccess, userMessage: string): Promise<AssistantReply> {
  const text = userMessage.trim();
  if (!text) throw new RuleError("Say something first.");

  const priorHistory = await getAssistantHistory(access);
  await appendMessage(access, "user", text);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const reply = "The trip assistant isn't configured yet — ask whoever runs this app to set ANTHROPIC_API_KEY.";
    await appendMessage(access, "assistant", reply);
    return { reply, pinned: [] };
  }

  const systemPrompt = await buildSystemPrompt(access);
  const pinned: Item[] = [];
  const outcome = await runAssistantTurn(apiKey, systemPrompt, priorHistory, text, TOOLS, buildExecutors(access, pinned));
  const reply = "reply" in outcome ? outcome.reply : outcome.error;

  await appendMessage(access, "assistant", reply);
  return { reply, pinned };
}

/**
 * What a caller watching a live turn sees, in order: any number of
 * `text_delta`/`tool_start` events (see assistant-agent.ts's
 * AgentStreamEvent -- these pass straight through), then exactly one
 * `done`. There's deliberately no separate `error` variant here -- an
 * internal failure (network, refusal, budget) is folded into `done` the
 * same plain-text way sendAssistantMessage above always has been, so it's
 * persisted and replayed as an ordinary assistant turn either way; a
 * caller that only cares about the final text doesn't need to branch on
 * two cases that both mean "here's what to show."
 */
export type AssistantStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "done"; reply: string; pinned: { id: string; title: string }[] };

/**
 * Same contract as sendAssistantMessage (persists both turns, the user's
 * message even if everything after it fails) but yields the reply as it's
 * written instead of only returning once it's complete -- what backs the
 * streaming /api/trip/[tripId]/assistant route AssistantChat.tsx talks to,
 * so a reply appears incrementally instead of the whole page waiting on
 * (and then reloading for) one big response.
 */
export async function* streamAssistantMessage(access: TripAccess, userMessage: string): AsyncGenerator<AssistantStreamEvent> {
  const text = userMessage.trim();
  if (!text) throw new RuleError("Say something first.");

  const priorHistory = await getAssistantHistory(access);
  await appendMessage(access, "user", text);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const reply = "The trip assistant isn't configured yet — ask whoever runs this app to set ANTHROPIC_API_KEY.";
    await appendMessage(access, "assistant", reply);
    yield { type: "done", reply, pinned: [] };
    return;
  }

  const systemPrompt = await buildSystemPrompt(access);
  const pinned: Item[] = [];
  let reply = "";
  for await (const event of streamAssistantTurn(apiKey, systemPrompt, priorHistory, text, TOOLS, buildExecutors(access, pinned))) {
    if (event.type === "text_delta" || event.type === "tool_start") {
      yield event;
    } else if (event.type === "done") {
      reply = event.reply;
    } else {
      reply = event.message;
    }
  }

  await appendMessage(access, "assistant", reply);
  yield { type: "done", reply, pinned: pinned.map((p) => ({ id: p.id, title: p.title })) };
}
