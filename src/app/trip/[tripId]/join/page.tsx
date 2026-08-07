import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { unresolvedBranchesForMember, type DayLocationKind } from "@/lib/days.ts";
import { formatCalendarDate } from "@/lib/time.ts";
import AddressAutocomplete from "../AddressAutocomplete.tsx";
import { resolveJoinWizardAction } from "./actions.ts";

const KIND_LABEL: Record<DayLocationKind, string> = {
  wake: "Wake location",
  sleep: "Sleep location",
  stop: "Stop",
};

/**
 * A mini onboarding wizard, shown once right after accepting an invite --
 * only when the trip actually has something ambiguous to resolve. Most of
 * what a trip has planned needs no decision at all: a day with a single
 * wake location, a single sleep location, gets the new member added to
 * each automatically the moment they accept (see days.ts's
 * autoIncludeSoleLocations, called from trips.ts's acceptInvite). This
 * page only ever lists the genuine forks -- two or more locations of the
 * same kind on the same day (a split departure, say) -- and only the ones
 * this particular member isn't part of yet.
 *
 * Entirely skippable: "Skip for now" just goes straight to the trip,
 * leaving every branch exactly as unresolved as it was -- still fixable
 * any time afterward via a day's own pencil editor, which is the same
 * mechanism this page's form uses under the hood.
 */
export default async function JoinTripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/trip/${tripId}/join`);

  let access;
  try {
    access = await requireTripAccess(tripId, user);
  } catch (err) {
    if (err instanceof AccessError) redirect("/trips");
    throw err;
  }

  const branches = await unresolvedBranchesForMember(tripId, user.id);
  if (branches.length === 0) redirect(`/trip/${tripId}`);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Which leg are you on?</h1>
        <p className="mt-1 text-sm text-stone-500">
          {access.trip.name} already splits up at a few points. Pick whichever is you, or add your own — you
          can always change this later from the day itself.
        </p>
      </div>

      <form action={resolveJoinWizardAction.bind(null, tripId)} className="space-y-4">
        {branches.map((branch) => (
          <div key={`${branch.dayId}:${branch.kind}`} className="rounded-md border border-stone-200 bg-white p-4">
            <p className="mb-2 text-sm font-medium text-stone-700">
              {formatCalendarDate(branch.date)} — {KIND_LABEL[branch.kind]}
            </p>
            <div className="space-y-2">
              {branch.locations.map((loc) => (
                <label key={loc.id} className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="radio" name={`branch__${branch.dayId}__${branch.kind}`} value={loc.id} />
                  I&apos;m with: {loc.name}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input type="radio" name={`branch__${branch.dayId}__${branch.kind}`} value="new" />
                Something else:
              </label>
              <AddressAutocomplete
                name={`newname__${branch.dayId}__${branch.kind}`}
                placeholder="e.g. a different town"
                className="input ml-6"
                restrict="place"
              />
            </div>
          </div>
        ))}

        <div className="flex items-center gap-4">
          <button type="submit" className="btn-primary">
            Save my choices
          </button>
          <a href={`/trip/${tripId}`} className="text-sm text-stone-500 underline hover:text-stone-700">
            Skip for now
          </a>
        </div>
      </form>
    </div>
  );
}
