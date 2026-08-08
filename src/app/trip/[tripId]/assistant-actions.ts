"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { requireTripAccess } from "@/lib/scope.ts";
import { sendAssistantMessage, clearAssistantHistory } from "@/lib/assistant.ts";

/** Redirects back to Scratchpad with an error banner instead of crashing the request -- same pattern as the trip page's own actions.ts. */
function withError(tripId: string, err: unknown): never {
  const message = err instanceof Error ? err.message : "Something went wrong.";
  redirect(`/trip/${tripId}?tab=scratchpad&error=${encodeURIComponent(message)}`);
}

/**
 * Sends one message to the trip assistant. Always redirects back to
 * Scratchpad afterward (rather than only revalidatePath) -- see the item
 * detail page's own history for why a Server Action that only revalidates
 * the current route doesn't reliably refresh what's on screen; this form
 * lives on the same route it submits to, so the same fix applies here.
 */
export async function sendAssistantMessageAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const message = String(formData.get("message") ?? "");

  try {
    await sendAssistantMessage(access, message);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}?tab=scratchpad`);
}

export async function clearAssistantHistoryAction(tripId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  await clearAssistantHistory(access);
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}?tab=scratchpad`);
}
