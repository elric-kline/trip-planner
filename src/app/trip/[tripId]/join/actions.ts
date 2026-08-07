"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { requireTripAccess } from "@/lib/scope.ts";
import { addLocationForSelf, joinLocation, unresolvedBranchesForMember } from "@/lib/days.ts";
import { geocodeAddress } from "@/lib/geocode.ts";

/** Same "no key/bad address/network error just means no coordinates" shape as everywhere else geocoding happens -- see trip/[tripId]/actions.ts's own copy of this. */
async function geocode(query: string | null | undefined): Promise<{ lat: number; lng: number } | null> {
  if (!query) return null;
  return geocodeAddress(query);
}

/**
 * Resolves as many of the join wizard's branches as the form answered --
 * one radio group per (day, kind) branch, named `branch__{dayId}__{kind}`,
 * either an existing location's id ("I'm with this one") or the sentinel
 * "new" paired with a `newname__{dayId}__{kind}` field ("something else").
 * Branches re-derived from the database rather than trusted from the
 * form's own hidden state, so this only ever acts on branches that are
 * actually still real and actually still unresolved for this viewer --
 * anything left blank, or naming a location that's since disappeared,
 * is simply skipped and stays unresolved (still fixable later via the
 * day's own pencil editor).
 */
export async function resolveJoinWizardAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);

  const branches = await unresolvedBranchesForMember(tripId, user.id);

  for (const branch of branches) {
    const fieldName = `branch__${branch.dayId}__${branch.kind}`;
    const selection = String(formData.get(fieldName) ?? "");
    if (!selection) continue;

    if (selection === "new") {
      const name = String(formData.get(`newname__${branch.dayId}__${branch.kind}`) ?? "").trim();
      if (!name) continue; // picked "something else" but never typed one
      const coords = await geocode(name);
      await addLocationForSelf(access, branch.dayId, branch.kind, {
        name,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      });
      continue;
    }

    const matched = branch.locations.find((l) => l.id === selection);
    if (matched) await joinLocation(access, matched.id);
  }

  redirect(`/trip/${tripId}`);
}
