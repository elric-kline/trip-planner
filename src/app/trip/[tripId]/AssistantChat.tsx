"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssistantTurn } from "@/lib/assistant.ts";

/** One parsed `data: {...}` frame from the streaming route -- see assistant.ts's AssistantStreamEvent, the server-side source of truth this mirrors. */
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "done"; reply: string; pinned: { id: string; title: string }[] };

const TOOL_LABEL: Record<string, string> = {
  search_places: "Searching for places…",
  get_place_details: "Looking up details…",
  estimate_travel: "Checking travel time…",
  pin_idea: "Saving that…",
  web_search: "Searching the web…",
};

/** Parses whatever's arrived so far into complete SSE frames, returning the parsed events plus whatever incomplete text is left to prepend to the next chunk. */
function parseSseFrames(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  let rest = buffer;
  let separatorIndex: number;
  while ((separatorIndex = rest.indexOf("\n\n")) !== -1) {
    const frame = rest.slice(0, separatorIndex);
    rest = rest.slice(separatorIndex + 2);
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice(5).trim()) as StreamEvent);
    } catch {
      // A malformed frame is skipped rather than aborting the whole stream -- same posture as the server's own SSE parser (see anthropic.ts's streamMessagesApi).
    }
  }
  return { events, rest };
}

/**
 * The trip assistant's chat panel, Scratchpad-scoped -- see schema.ts's
 * assistantMessages doc for why history is loaded server-side per (trip,
 * viewer) rather than fetched client-side. `history` below is only the
 * *initial* paint (from the server component that renders this); every
 * send from here on is a plain client fetch against
 * /api/trip/[tripId]/assistant reading a Server-Sent Events stream, not a
 * Server Action -- the previous version redirected the whole page to show
 * a reply, which is what made every message feel like a fresh page load.
 * This renders the reply as it's written and never navigates at all.
 *
 * Tab switches in this app are plain `<a href="?tab=...">` links (a real
 * navigation, not client-side routing -- see page.tsx), so this component
 * fully remounts on every visit to Scratchpad; initializing state from the
 * `history` prop once is safe, there's no stale-state risk from a soft
 * navigation reusing this instance.
 *
 * A pinned idea is the one thing that still needs the rest of the page to
 * catch up (the "My ideas" list elsewhere on Scratchpad) -- router.refresh()
 * only fires when something actually got pinned, and it's a soft, in-place
 * refetch of the server components, not a navigation: no URL change, no
 * scroll reset, nothing that reads as "the page reloaded."
 */
export default function AssistantChat({ tripId, history }: { tripId: string; history: AssistantTurn[] }) {
  const router = useRouter();
  const [messages, setMessages] = useState<AssistantTurn[]>(history);
  const [pending, setPending] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function updateLastAssistantMessage(update: (content: string) => string) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { role: "assistant", content: update(last?.content ?? "") };
      return next;
    });
  }

  async function send(text: string) {
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setPending(true);
    setToolStatus(null);
    setRequestError(null);

    let response: Response;
    try {
      response = await fetch(`/api/trip/${tripId}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
    } catch {
      setPending(false);
      setRequestError("Couldn't reach the server — check your connection and try again.");
      setMessages((prev) => prev.slice(0, -2)); // undo the optimistic bubbles -- nothing was actually sent
      return;
    }

    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null);
      setPending(false);
      setRequestError(body?.error ?? "Something went wrong — try again.");
      setMessages((prev) => prev.slice(0, -2));
      return;
    }

    let pinnedCount = 0;
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseFrames(buffer);
        buffer = rest;

        for (const event of events) {
          if (event.type === "text_delta") {
            setToolStatus(null);
            updateLastAssistantMessage((content) => content + event.text);
          } else if (event.type === "tool_start") {
            setToolStatus(TOOL_LABEL[event.name] ?? "Working on it…");
          } else if (event.type === "done") {
            pinnedCount = event.pinned.length;
            updateLastAssistantMessage(() => event.reply);
          }
        }
      }
    } catch {
      setRequestError("The connection dropped partway through — what came through is still saved above.");
    }

    setPending(false);
    setToolStatus(null);
    if (pinnedCount > 0) startTransition(() => router.refresh());
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const value = textareaRef.current?.value.trim();
    if (!value || pending) return;
    if (textareaRef.current) textareaRef.current.value = "";
    void send(value);
  }

  async function handleClear() {
    setMessages([]);
    setRequestError(null);
    try {
      await fetch(`/api/trip/${tripId}/assistant`, { method: "DELETE" });
    } catch {
      // Cleared locally either way -- a failed request here just risks the
      // thread reappearing on next load, not worth a scary error banner
      // for what's a low-stakes "clear the scratch space" action.
    }
  }

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs text-stone-400">
          Knows what&apos;s locked, what&apos;s being discussed in PlaySpace, and what&apos;s in your own ideas
          here — including who else on the trip is doing what, and when. Ask for suggestions, or say something
          like &quot;pin that one&quot; to save a suggestion here.
        </p>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            className="shrink-0 text-xs whitespace-nowrap text-stone-400 underline hover:text-stone-700"
          >
            Clear conversation
          </button>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="mb-3 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-400">
          Try something like: &quot;We land at SEATAC around noon — help me find some grab-and-go lunch ideas in a
          walkable part of the city, on the way to our next stop.&quot;
        </p>
      ) : (
        <div ref={scrollRef} className="mb-3 max-h-[32rem] space-y-3 overflow-y-auto">
          {messages.map((turn, i) => (
            <div
              key={i}
              className={
                turn.role === "user"
                  ? "ml-8 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-800"
                  : "mr-8 rounded-md bg-teal-50 px-3 py-2 text-sm text-stone-800"
              }
            >
              <p className="whitespace-pre-wrap">
                {turn.content}
                {pending && i === messages.length - 1 && turn.role === "assistant" && (
                  <span className="ml-0.5 inline-block animate-pulse text-stone-400">▍</span>
                )}
              </p>
            </div>
          ))}
          {pending && toolStatus && <p className="text-xs text-stone-400">{toolStatus}</p>}
        </div>
      )}

      {requestError && <p className="mb-2 text-xs text-red-600">{requestError}</p>}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <textarea
          ref={textareaRef}
          name="message"
          required
          rows={2}
          disabled={pending}
          placeholder="Ask the trip assistant…"
          className="input flex-1 disabled:opacity-60"
        />
        <button type="submit" disabled={pending} className="btn-primary shrink-0 self-end disabled:opacity-60">
          {pending ? "Thinking…" : "Send"}
        </button>
      </form>
    </div>
  );
}
