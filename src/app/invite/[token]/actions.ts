"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { acceptInvite } from "@/lib/trips.ts";
import { AccessError } from "@/lib/scope.ts";
import { unresolvedBranchesForMember } from "@/lib/days.ts";

export async function acceptInviteAction(token: string): Promise<void> {
  const user = await requireUser();

  let tripId: string;
  try {
    tripId = await acceptInvite(token, user);
  } catch (err) {
    const message = err instanceof AccessError ? err.message : "Could not accept that invite.";
    redirect(`/invite/${token}?error=${encodeURIComponent(message)}`);
  }

  // acceptInvite already auto-included them anywhere there was no real
  // choice to make (see autoIncludeSoleLocations) -- only route through
  // the join wizard when there's an actual split (two-plus locations of
  // the same kind on the same day) they aren't part of yet. Most trips
  // never have one, so this is the common-case straight-to-trip path.
  const branches = await unresolvedBranchesForMember(tripId, user.id);
  redirect(branches.length > 0 ? `/trip/${tripId}/join` : `/trip/${tripId}`);
}
