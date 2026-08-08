import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { streamAssistantMessage, clearAssistantHistory } from "@/lib/assistant.ts";

/**
 * What AssistantChat.tsx actually talks to -- a client-fetched streaming
 * endpoint instead of a Server Action, so a reply can render token by
 * token and the rest of the page never has to redirect/reload to show it
 * (see AssistantChat.tsx's own doc comment for why that mattered).
 *
 * Auth-gated the same way as /api/dining/infer -- 401/404 JSON rather than
 * a redirect, since this is a client fetch, not a page navigation.
 */
async function resolveAccess(tripId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: Response.json({ error: "Not signed in." }, { status: 401 }) };
  try {
    return { access: await requireTripAccess(tripId, user) };
  } catch (err) {
    if (err instanceof AccessError) return { error: Response.json({ error: "Not found." }, { status: 404 }) };
    throw err;
  }
}

/**
 * Streams one reply as Server-Sent Events -- each frame is one
 * AssistantStreamEvent (see assistant.ts), `text_delta`/`tool_start` as
 * the turn plays out and exactly one final `done`. Validated and
 * persisted the same way sendAssistantMessage always was; this only
 * changes *how* the reply is delivered to the client, not what's stored.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const resolved = await resolveAccess(tripId);
  if (resolved.error) return resolved.error;

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "Say something first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamAssistantMessage(resolved.access, message)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        // The user's turn is already persisted by the time streamAssistantMessage
        // could throw (it appends that before doing anything else) -- an
        // unexpected failure here still owes the client a terminal event so
        // the chat doesn't spin forever, it just can't be more specific.
        console.warn("[assistant] stream handler failed:", err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "done", reply: "Something went wrong -- try again.", pinned: [] })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** "Clear conversation" -- only this viewer's own thread, same rule as clearAssistantHistory itself. */
export async function DELETE(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const resolved = await resolveAccess(tripId);
  if (resolved.error) return resolved.error;

  await clearAssistantHistory(resolved.access);
  return Response.json({ ok: true });
}
