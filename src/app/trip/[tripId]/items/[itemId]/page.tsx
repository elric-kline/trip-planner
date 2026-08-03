import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, canEditItem, getItem, requireTripAccess } from "@/lib/scope.ts";
import { attendanceFor, myRsvp } from "@/lib/attendance.ts";
import { checkRsvp, checkUnlock } from "@/lib/lifecycle.ts";
import {
  declineItemAction,
  deleteItemAction,
  lockPrivateItemAction,
  restoreItemAction,
  scheduleItemAction,
  setRsvpAction,
  unlockItemAction,
  unscheduleItemAction,
  updateItemAction,
} from "../../actions.ts";
import { canLockItem } from "@/lib/scope.ts";
import { utcToZonedInputValue } from "@/lib/time.ts";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ tripId: string; itemId: string }>;
}) {
  const user = await getCurrentUser();
  const { tripId, itemId } = await params;
  if (!user) redirect(`/login?next=/trip/${tripId}/items/${itemId}`);

  let access;
  let item;
  try {
    access = await requireTripAccess(tripId, user);
    item = await getItem(access, itemId);
  } catch (err) {
    if (err instanceof AccessError) redirect(`/trip/${tripId}`);
    throw err;
  }

  const attendance = await attendanceFor(access, item);
  const myResponse = item.status === "locked" && item.commitment === "optional" ? await myRsvp(access, itemId) : null;
  const editable = canEditItem(access, item);
  const rsvpAllowed = checkRsvp(item).ok;
  const unlockAllowed = checkUnlock(item, { isPlanner: access.isPlanner, isAuthor: item.createdBy === access.viewer.id }).ok;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <a href={`/trip/${tripId}`} className="text-sm text-stone-500 underline">
        ← Back to trip
      </a>

      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{item.title}</h1>
          <span className="badge bg-stone-100 text-stone-700">{item.status}</span>
          {item.commitment && <span className="badge bg-emerald-100 text-emerald-800">{item.commitment}</span>}
          {item.visibility === "private" && (
            <span className="badge bg-purple-100 text-purple-700">Private</span>
          )}
        </div>
        {item.locationName && <p className="text-sm text-stone-500">{item.locationName}</p>}
        {item.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700">{item.notes}</p>}
      </div>

      {item.status === "locked" && (
        <section className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-700">
            Who's {item.commitment === "required" ? "on this" : "in"}
          </h2>
          {item.visibility === "private" ? (
            <p className="text-sm text-stone-500">Just you.</p>
          ) : item.commitment === "required" ? (
            <p className="text-sm text-stone-500">Everyone on the trip — this is required.</p>
          ) : (
            <div className="space-y-1 text-sm">
              <p className="text-stone-600">
                Yes: {attendance.attendees.map((m) => m.name ?? m.email).join(", ") || "—"}
              </p>
              <p className="text-stone-400">
                Awaiting: {attendance.awaiting.map((m) => m.name ?? m.email).join(", ") || "—"}
              </p>
              {attendance.declined.length > 0 && (
                <p className="text-stone-400">
                  No: {attendance.declined.map((m) => m.name ?? m.email).join(", ")}
                </p>
              )}
            </div>
          )}

          {rsvpAllowed && (
            <div className="mt-3 flex gap-2">
              {(["yes", "maybe", "no"] as const).map((r) => (
                <form key={r} action={setRsvpAction.bind(null, tripId, itemId, r)}>
                  <button className={myResponse === r ? "btn-primary" : "btn-secondary"}>
                    {r === "yes" ? "I'm in" : r === "maybe" ? "Maybe" : "Can't make it"}
                  </button>
                </form>
              ))}
            </div>
          )}

          {unlockAllowed && (
            <form action={unlockItemAction.bind(null, tripId, itemId)} className="mt-3">
              <button className="btn-secondary">Unlock</button>
            </form>
          )}
        </section>
      )}

      {item.status !== "locked" && item.status !== "declined" && (
        <section className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Schedule</h2>
          <form action={scheduleItemAction.bind(null, tripId, itemId)} className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-stone-700">Starts</span>
              <input
                type="datetime-local"
                name="startsAt"
                required
                defaultValue={item.startsAt ? utcToZonedInputValue(item.startsAt, item.timezone ?? access.trip.timezone) : ""}
                className="input"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-stone-700">Ends (optional)</span>
              <input
                type="datetime-local"
                name="endsAt"
                defaultValue={item.endsAt ? utcToZonedInputValue(item.endsAt, item.timezone ?? access.trip.timezone) : ""}
                className="input"
              />
            </label>
            <button className="btn-primary">
              {item.status === "proposed" ? "Update time" : "Propose a time"}
            </button>
          </form>

          {item.status === "proposed" && (
            <form action={unscheduleItemAction.bind(null, tripId, itemId)} className="mt-2">
              <button className="text-sm text-stone-500 underline">Move back to ideas (drop the time)</button>
            </form>
          )}

          {item.status === "proposed" && canLockItem(access) && item.visibility === "group" && (
            <a
              href={`/trip/${tripId}/items/${itemId}/lock`}
              className="mt-3 inline-block btn-primary"
            >
              Lock this in →
            </a>
          )}

          {item.status === "proposed" && item.visibility === "private" && item.createdBy === access.viewer.id && (
            <form action={lockPrivateItemAction.bind(null, tripId, itemId)} className="mt-3">
              <button className="btn-primary">Lock in my private plan</button>
            </form>
          )}
        </section>
      )}

      {editable && item.status !== "locked" && (
        <section className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Edit</h2>
          <form action={updateItemAction.bind(null, tripId, itemId)} className="grid gap-3">
            <input name="title" defaultValue={item.title} className="input" />
            <select name="category" defaultValue={item.category} className="input">
              <option value="lodging">Lodging</option>
              <option value="dining">Dining</option>
              <option value="activity">Activity</option>
              <option value="transport">Transport</option>
              <option value="other">Other</option>
            </select>
            <input name="locationName" defaultValue={item.locationName ?? ""} className="input" placeholder="Location" />
            <div className="grid grid-cols-2 gap-3">
              <input
                name="locationLat"
                type="number"
                step="any"
                defaultValue={item.locationLat ?? ""}
                placeholder="Latitude"
                className="input"
              />
              <input
                name="locationLng"
                type="number"
                step="any"
                defaultValue={item.locationLng ?? ""}
                placeholder="Longitude"
                className="input"
              />
            </div>
            <textarea name="notes" defaultValue={item.notes ?? ""} className="input" rows={3} />
            <button className="btn-secondary justify-self-start">Save</button>
          </form>
        </section>
      )}

      <section className="flex gap-2">
        {item.status === "declined" ? (
          <form action={restoreItemAction.bind(null, tripId, itemId)}>
            <button className="btn-secondary">Restore</button>
          </form>
        ) : (
          item.status !== "locked" && (
            <form action={declineItemAction.bind(null, tripId, itemId)}>
              <button className="btn-secondary">Decline</button>
            </form>
          )
        )}
        {item.status !== "locked" && (editable || access.isPlanner) && (
          <form action={deleteItemAction.bind(null, tripId, itemId)}>
            <button className="text-sm text-red-600 underline">Delete</button>
          </form>
        )}
      </section>
    </div>
  );
}
