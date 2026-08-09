import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, canLockItem, getItem, requireTripAccess } from "@/lib/scope.ts";
import { previewLockImpact, type LockPreview } from "@/lib/conflicts-for.ts";
import { defaultFlightStatusProvider } from "@/lib/flight-status.ts";
import { lockItemAction } from "../../../actions.ts";

/**
 * What the check covered, then what it found, then what it couldn't see.
 *
 * The last part is the point. This used to print a flat "No new conflicts for
 * anyone" whenever it turned up nothing -- including when it had inspected
 * nobody at all, because an optional item with no backers puts the whole
 * preview on an empty set. A confident sentence about an incomplete check, at
 * the moment somebody commits the group.
 */
function PreviewBody({ preview, commitment }: { preview: LockPreview; commitment: "required" | "optional" }) {
  const { checked, impacts, blindSpots } = preview;

  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-500">
        {checked.length === 0
          ? commitment === "optional"
            ? "Nobody has said they're in yet, so there's nothing to check against."
            : "No one on the trip yet."
          : `Checked ${checked.length === 1 ? "1 schedule" : `${checked.length} schedules`}: ${checked
              .map((m) => m.name ?? m.email)
              .join(", ")}.`}
      </p>

      {impacts.length === 0 ? (
        checked.length > 0 && <p className="text-sm text-emerald-700">No new conflicts for them.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {impacts.map((impact) => (
            <li key={impact.member.userId} className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
              <strong>{impact.member.name ?? impact.member.email}</strong>
              <ul className="mt-1 list-disc pl-5">
                {impact.newFindings.map((f, i) => (
                  <li key={i}>
                    {f.severity === "conflict" ? "Conflict" : "Tight"}: <strong>{f.before.title}</strong> →{" "}
                    <strong>{f.after.title}</strong>
                    {f.reason === "overlap"
                      ? " — these overlap in time."
                      : ` — only ${Math.round(f.gapMinutes)} min for a ~${f.travelMinutes} min trip.`}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {blindSpots.length > 0 && (
        <div className="rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-600">
          <p className="mb-1">Can&apos;t say yet:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {blindSpots.map((spot) => (
              <li key={spot.itemId}>
                {spot.members.map((m) => m.name ?? m.email).join(", ")}{" "}
                {spot.members.length === 1 ? "hasn't" : "haven't"} answered{" "}
                <strong>{spot.title}</strong>, which overlaps this — if that turns into a yes, it clashes.
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default async function LockPreviewPage({
  params,
}: {
  params: Promise<{ tripId: string; itemId: string }>;
}) {
  const user = await getCurrentUser();
  const { tripId, itemId } = await params;
  if (!user) redirect(`/login?next=/trip/${tripId}/items/${itemId}/lock`);

  let access;
  let item;
  try {
    access = await requireTripAccess(tripId, user);
    item = await getItem(access, itemId);
  } catch (err) {
    if (err instanceof AccessError) redirect(`/trip/${tripId}`);
    throw err;
  }

  if (!canLockItem(access) || item.status !== "proposed" || item.visibility !== "group" || !item.startsAt) {
    redirect(`/trip/${tripId}/items/${itemId}`);
  }

  // Same provider instance for both calls below -- each previewLockImpact
  // call still does its own live-status lookups (there's no caching in
  // AeroDataBoxFlightStatusProvider itself), this just avoids constructing
  // it twice.
  const flightStatusProvider = defaultFlightStatusProvider();
  const [requiredImpact, optionalImpact] = await Promise.all([
    previewLockImpact(access, item, "required", undefined, flightStatusProvider),
    previewLockImpact(access, item, "optional", undefined, flightStatusProvider),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <a
        href={`/trip/${tripId}/items/${itemId}`}
        className="inline-flex min-h-11 items-center text-sm text-stone-500 underline"
      >
        ← Back
      </a>
      <div>
        <h1 className="text-xl font-semibold">Lock in “{item.title}”</h1>
        <p className="text-sm text-stone-500">Choose whether this is on the bus or opt-in.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="font-medium">Required</h2>
          <p className="mb-3 text-sm text-stone-500">
            Everyone on the trip is automatically attending — no RSVP.
          </p>
          <div className="mb-3">
            <PreviewBody preview={requiredImpact} commitment="required" />
          </div>
          <form action={lockItemAction.bind(null, tripId, itemId, "required")}>
            <button className="btn-primary w-full">Lock as required</button>
          </form>
        </div>

        <div className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="font-medium">Optional</h2>
          <p className="mb-3 text-sm text-stone-500">
            Booked and reserved, but people opt in via RSVP.
          </p>
          <div className="mb-3">
            <PreviewBody preview={optionalImpact} commitment="optional" />
          </div>
          <form action={lockItemAction.bind(null, tripId, itemId, "optional")}>
            <button className="btn-secondary w-full">Lock as optional</button>
          </form>
        </div>
      </div>
    </div>
  );
}
