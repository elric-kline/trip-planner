"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { acceptInvite } from "@/lib/trips.ts";
import { AccessError } from "@/lib/scope.ts";

export async function acceptInviteAction(token: string): Promise<void> {
  const user = await requireUser();

  let tripId: string;
  try {
    tripId = await acceptInvite(token, user);
  } catch (err) {
    const message = err instanceof AccessError ? err.message : "Could not accept that invite.";
    redirect(`/invite/${token}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/trip/${tripId}`);
}
