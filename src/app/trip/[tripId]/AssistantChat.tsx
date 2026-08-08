"use client";

import { useFormStatus } from "react-dom";
import type { AssistantTurn } from "@/lib/assistant.ts";
import { sendAssistantMessageAction, clearAssistantHistoryAction } from "./assistant-actions.ts";

/**
 * useFormStatus only reports the status of the nearest enclosing <form> a
 * component renders inside -- so this has to be a child of the send form,
 * not a sibling, to know when a message is in flight.
 */
function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary shrink-0 self-end disabled:opacity-60">
      {pending ? "Thinking…" : "Send"}
    </button>
  );
}

/**
 * The trip assistant's chat panel, Scratchpad-scoped -- see schema.ts's
 * assistantMessages doc for why history is loaded server-side per (trip,
 * viewer) rather than fetched client-side. Both the send and clear actions
 * redirect back to this same route/tab on completion (see
 * assistant-actions.ts) rather than relying on revalidatePath alone, so a
 * reply or a cleared thread actually shows up without a manual reload.
 *
 * A full round trip (the model, possibly multiple tool calls, maybe a web
 * search) can take several seconds -- this is a plain Server Action
 * request/response, not a stream, so "Thinking…" via useFormStatus is the
 * only progress indicator for now. Streaming would need a client-fetched
 * API route instead of a Server Action, a bigger architectural change than
 * this first version takes on.
 */
export default function AssistantChat({ tripId, history }: { tripId: string; history: AssistantTurn[] }) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs text-stone-400">
          Knows what&apos;s locked, what&apos;s being discussed in PlaySpace, and what&apos;s in your own ideas
          here — including who else on the trip is doing what, and when. Ask for suggestions, or say something
          like &quot;pin that one&quot; to save a suggestion here.
        </p>
        {history.length > 0 && (
          <form action={clearAssistantHistoryAction.bind(null, tripId)} className="shrink-0">
            <button type="submit" className="text-xs whitespace-nowrap text-stone-400 underline hover:text-stone-700">
              Clear conversation
            </button>
          </form>
        )}
      </div>

      {history.length === 0 ? (
        <p className="mb-3 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-400">
          Try something like: &quot;We land at SEATAC around noon — help me find some grab-and-go lunch ideas in a
          walkable part of the city, on the way to our next stop.&quot;
        </p>
      ) : (
        <div className="mb-3 max-h-[32rem] space-y-3 overflow-y-auto">
          {history.map((turn, i) => (
            <div
              key={i}
              className={
                turn.role === "user"
                  ? "ml-8 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-800"
                  : "mr-8 rounded-md bg-teal-50 px-3 py-2 text-sm text-stone-800"
              }
            >
              <p className="whitespace-pre-wrap">{turn.content}</p>
            </div>
          ))}
        </div>
      )}

      <form action={sendAssistantMessageAction.bind(null, tripId)} className="flex gap-2">
        <textarea
          name="message"
          required
          rows={2}
          placeholder="Ask the trip assistant…"
          className="input flex-1"
        />
        <SendButton />
      </form>
    </div>
  );
}
