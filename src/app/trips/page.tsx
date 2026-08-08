import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { tripsForUser } from "@/lib/trips.ts";
import { derivePhase, PHASE_LABEL } from "@/lib/phase.ts";
import { formatTripDateRange } from "@/lib/time.ts";

export default async function TripsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/trips");

  const rows = await tripsForUser(user);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your trips</h1>
        <a href="/trips/new" className="btn-primary">
          New trip
        </a>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">
          No trips yet. Start one and invite the group.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
          {rows.map(({ trip, role }) => (
            <li key={trip.id}>
              <a
                href={`/trip/${trip.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-stone-50"
              >
                <div>
                  <div className="font-medium">{trip.name}</div>
                  <div className="text-sm text-stone-500">
                    {trip.destination} · {formatTripDateRange(trip.startDate, trip.endDate)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {role === "master_planner" && (
                    <span className="badge bg-amber-100 text-amber-800">Planner</span>
                  )}
                  {role === "co_planner" && (
                    <span className="badge bg-amber-50 text-amber-700">Co-planner</span>
                  )}
                  <span className="badge bg-stone-100 text-stone-700">
                    {PHASE_LABEL[derivePhase(trip)]}
                  </span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
