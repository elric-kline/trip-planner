import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, canLockItem, getItem, requireTripAccess } from "@/lib/scope.ts";
import { previewLockImpact, type LockImpact } from "@/lib/conflicts-for.ts";
import { lockItemAction } from "../../../actions.ts";

function ImpactList({ impacts }: { impacts: LockImpact[] }) {
  if (impacts.length === 0) {
    return <p className="text-sm text-emerald-700">No new conflicts for anyone.</p>;
  }
  return (
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

  const [requiredImpact, optionalImpact] = await Promise.all([
    previewLockImpact(access, item, "required"),
    previewLockImpact(access, item, "optional"),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <a href={`/trip/${tripId}/items/${itemId}`} className="text-sm text-stone-500 underline">
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
            <ImpactList impacts={requiredImpact} />
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
            <ImpactList impacts={optionalImpact} />
          </div>
          <form action={lockItemAction.bind(null, tripId, itemId, "optional")}>
            <button className="btn-secondary w-full">Lock as optional</button>
          </form>
        </div>
      </div>
    </div>
  );
}
