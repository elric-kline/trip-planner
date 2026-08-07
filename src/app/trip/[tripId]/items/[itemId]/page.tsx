import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, canEditItem, getItem, requireTripAccess } from "@/lib/scope.ts";
import { attendanceFor, myRsvp } from "@/lib/attendance.ts";
import { checkRsvp, checkUnlock } from "@/lib/lifecycle.ts";
import { getLodgingDetails } from "@/lib/lodging.ts";
import { getDiningDetails } from "@/lib/dining.ts";
import { dietaryWarningsForItem } from "@/lib/dietary-conflicts-for.ts";
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
  updateLodgingDetailsAction,
  updateDiningDetailsAction,
} from "../../actions.ts";
import { canLockItem } from "@/lib/scope.ts";
import { utcToZonedInputValue } from "@/lib/time.ts";
import AddressAutocomplete from "../../AddressAutocomplete.tsx";
import { DIETARY_TAGS, DIETARY_TAG_LABEL } from "@/lib/dietary.ts";

const PAYMENT_STATUS_LABEL = {
  prepaid: "Prepaid",
  partial: "Partially paid",
  pay_on_arrival: "Pay on arrival",
} as const;

const PRICE_RANGES = ["$", "$$", "$$$", "$$$$"] as const;

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
  const lodging = item.category === "lodging" ? await getLodgingDetails(itemId) : null;
  const dining = item.category === "dining" ? await getDiningDetails(itemId) : null;
  const dietaryFindings = dining ? await dietaryWarningsForItem(access, item, dining.accommodates) : [];
  // Booking details are the thing that gets corrected after an item locks
  // (a late confirmation number, a fixed check-in code) — gated on the same
  // rule as the item itself, not the page's extra "not locked" restriction
  // the base title/notes edit form imposes below.
  const lodgingEditable = item.category === "lodging" && editable;
  const diningEditable = item.category === "dining" && editable;
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

      {item.category === "lodging" && (lodging || lodgingEditable) && (
        <section className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Lodging details</h2>

          {lodgingEditable ? (
            <form
              action={updateLodgingDetailsAction.bind(null, tripId, itemId)}
              className="grid gap-3"
            >
              <AddressAutocomplete
                name="address"
                defaultValue={lodging?.address}
                placeholder="Address"
                className="input"
              />
              <p className="-mt-2 text-xs text-stone-400">
                Coordinates for the map and travel-time conflict checks are looked up from this automatically.
              </p>
              <textarea
                name="checkInInstructions"
                defaultValue={lodging?.checkInInstructions ?? ""}
                placeholder="Check-in instructions (e.g. lockbox code, self check-in)"
                className="input"
                rows={2}
              />
              <div className="grid grid-cols-3 gap-3">
                <input
                  name="contactName"
                  defaultValue={lodging?.contactName ?? ""}
                  placeholder="Contact name (optional)"
                  className="input"
                />
                <input
                  name="contactPhone"
                  defaultValue={lodging?.contactPhone ?? ""}
                  placeholder="Contact phone"
                  className="input"
                />
                <input
                  name="contactEmail"
                  type="email"
                  defaultValue={lodging?.contactEmail ?? ""}
                  placeholder="Contact email"
                  className="input"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  name="confirmationNumber"
                  defaultValue={lodging?.confirmationNumber ?? ""}
                  placeholder="Confirmation number"
                  className="input"
                />
                <select name="bookedBy" defaultValue={lodging?.bookedBy ?? ""} className="input">
                  <option value="">Booked under (optional)</option>
                  {access.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <select
                  name="paymentStatus"
                  defaultValue={lodging?.paymentStatus ?? ""}
                  className="input"
                >
                  <option value="">Payment status</option>
                  <option value="prepaid">Prepaid</option>
                  <option value="partial">Partially paid</option>
                  <option value="pay_on_arrival">Pay on arrival</option>
                </select>
                <input
                  name="costAmount"
                  type="number"
                  step="any"
                  defaultValue={lodging?.costAmount ?? ""}
                  placeholder="Cost"
                  className="input"
                />
                <input
                  name="costCurrency"
                  defaultValue={lodging?.costCurrency ?? ""}
                  placeholder="USD"
                  className="input"
                  maxLength={8}
                />
              </div>
              <label className="text-sm">
                <span className="mb-1 block text-stone-700">Cancel by (optional)</span>
                <input
                  type="datetime-local"
                  name="cancellationDeadline"
                  defaultValue={
                    lodging?.cancellationDeadline
                      ? utcToZonedInputValue(lodging.cancellationDeadline, access.trip.timezone)
                      : ""
                  }
                  className="input"
                />
              </label>
              <input
                name="bookingUrl"
                type="url"
                defaultValue={lodging?.bookingUrl ?? ""}
                placeholder="Booking link (optional)"
                className="input"
              />
              <button className="btn-secondary justify-self-start">Save lodging details</button>
            </form>
          ) : (
            lodging && (
              <dl className="space-y-1.5 text-sm text-stone-700">
                {lodging.address && (
                  <Field label="Address">{lodging.address}</Field>
                )}
                {lodging.checkInInstructions && (
                  <Field label="Check-in instructions">
                    <span className="whitespace-pre-wrap">{lodging.checkInInstructions}</span>
                  </Field>
                )}
                {(lodging.contactName || lodging.contactPhone || lodging.contactEmail) && (
                  <Field label="Contact">
                    {[lodging.contactName, lodging.contactPhone, lodging.contactEmail]
                      .filter(Boolean)
                      .join(" · ")}
                  </Field>
                )}
                {lodging.confirmationNumber && (
                  <Field label="Confirmation #">{lodging.confirmationNumber}</Field>
                )}
                {lodging.bookedBy && (
                  <Field label="Booked under">
                    {access.members.find((m) => m.userId === lodging.bookedBy)?.name ??
                      access.members.find((m) => m.userId === lodging.bookedBy)?.email ??
                      "—"}
                  </Field>
                )}
                {(lodging.paymentStatus || lodging.costAmount != null) && (
                  <Field label="Payment">
                    {lodging.paymentStatus ? PAYMENT_STATUS_LABEL[lodging.paymentStatus] : ""}
                    {lodging.costAmount != null &&
                      ` — ${lodging.costAmount} ${lodging.costCurrency ?? ""}`.trim()}
                  </Field>
                )}
                {lodging.cancellationDeadline && (
                  <Field label="Cancel by">
                    {new Intl.DateTimeFormat("en-US", {
                      timeZone: access.trip.timezone,
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(lodging.cancellationDeadline)}
                  </Field>
                )}
                {lodging.bookingUrl && (
                  <Field label="Booking link">
                    <a href={lodging.bookingUrl} className="text-teal-700 underline break-all">
                      {lodging.bookingUrl}
                    </a>
                  </Field>
                )}
              </dl>
            )
          )}
        </section>
      )}

      {dietaryFindings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="mb-2 text-sm font-medium text-amber-900">
            May not work for {dietaryFindings.length === 1 ? "someone on this" : "everyone on this"}
          </p>
          <ul className="space-y-1 text-sm text-amber-800">
            {dietaryFindings.map((f, i) => (
              <li key={i}>
                <strong>{f.member.name ?? f.member.email}</strong> —{" "}
                {f.unmetTags.map((t) => DIETARY_TAG_LABEL[t]).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.category === "dining" && (dining || diningEditable) && (
        <section className="rounded-md border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Dining details</h2>

          {diningEditable ? (
            <form
              action={updateDiningDetailsAction.bind(null, tripId, itemId)}
              className="grid gap-3"
            >
              <input
                name="cuisine"
                defaultValue={dining?.cuisine ?? ""}
                placeholder="Cuisine (e.g. Neapolitan pizza)"
                className="input"
              />
              <div>
                <p className="mb-1 text-xs text-stone-500">Accommodates</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  {DIETARY_TAGS.map((tag) => (
                    <label key={tag} className="flex items-center gap-2 text-sm text-stone-700">
                      <input
                        type="checkbox"
                        name="accommodates"
                        value={tag}
                        defaultChecked={dining?.accommodates?.includes(tag) ?? false}
                      />
                      {DIETARY_TAG_LABEL[tag]}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <input
                  name="partySize"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={dining?.partySize ?? ""}
                  placeholder="Party size"
                  className="input"
                />
                <select name="priceRange" defaultValue={dining?.priceRange ?? ""} className="input">
                  <option value="">Price</option>
                  {PRICE_RANGES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  name="contactPhone"
                  defaultValue={dining?.contactPhone ?? ""}
                  placeholder="Restaurant phone"
                  className="input"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  name="confirmationNumber"
                  defaultValue={dining?.confirmationNumber ?? ""}
                  placeholder="Confirmation number"
                  className="input"
                />
                <select name="reservedBy" defaultValue={dining?.reservedBy ?? ""} className="input">
                  <option value="">Reserved under (optional)</option>
                  {access.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </select>
              </div>
              <input
                name="reservationUrl"
                type="url"
                defaultValue={dining?.reservationUrl ?? ""}
                placeholder="Reservation link (optional)"
                className="input"
              />
              <textarea
                name="specialRequests"
                defaultValue={dining?.specialRequests ?? ""}
                placeholder="Special requests (optional) — high chair, occasion, etc."
                className="input"
                rows={2}
              />
              <button className="btn-secondary justify-self-start">Save dining details</button>
            </form>
          ) : (
            dining && (
              <dl className="space-y-1.5 text-sm text-stone-700">
                {dining.cuisine && <Field label="Cuisine">{dining.cuisine}</Field>}
                {dining.accommodates && dining.accommodates.length > 0 && (
                  <Field label="Accommodates">
                    {dining.accommodates.map((tag) => DIETARY_TAG_LABEL[tag]).join(" · ")}
                  </Field>
                )}
                {dining.partySize != null && <Field label="Party size">{dining.partySize}</Field>}
                {dining.priceRange && <Field label="Price">{dining.priceRange}</Field>}
                {dining.contactPhone && <Field label="Restaurant phone">{dining.contactPhone}</Field>}
                {dining.confirmationNumber && (
                  <Field label="Confirmation #">{dining.confirmationNumber}</Field>
                )}
                {dining.reservedBy && (
                  <Field label="Reserved under">
                    {access.members.find((m) => m.userId === dining.reservedBy)?.name ??
                      access.members.find((m) => m.userId === dining.reservedBy)?.email ??
                      "—"}
                  </Field>
                )}
                {dining.reservationUrl && (
                  <Field label="Reservation link">
                    <a href={dining.reservationUrl} className="text-teal-700 underline break-all">
                      {dining.reservationUrl}
                    </a>
                  </Field>
                )}
                {dining.specialRequests && (
                  <Field label="Special requests">
                    <span className="whitespace-pre-wrap">{dining.specialRequests}</span>
                  </Field>
                )}
              </dl>
            )
          )}
        </section>
      )}

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
          <h2 className="mb-2 text-sm font-semibold text-stone-700">
            {item.category === "lodging" ? "Check-in / check-out" : "Schedule"}
          </h2>
          <form action={scheduleItemAction.bind(null, tripId, itemId)} className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-stone-700">
                {item.category === "lodging" ? "Check-in" : "Starts"}
              </span>
              <input
                type="datetime-local"
                name="startsAt"
                required
                defaultValue={item.startsAt ? utcToZonedInputValue(item.startsAt, item.timezone ?? access.trip.timezone) : ""}
                className="input"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-stone-700">
                {item.category === "lodging" ? "Check-out (optional)" : "Ends (optional)"}
              </span>
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
            <AddressAutocomplete name="locationName" defaultValue={item.locationName} className="input" placeholder="Location" />
            <p className="-mt-2 text-xs text-stone-400">
              Coordinates are looked up automatically from this{item.category === "lodging" ? ", or from the address below," : ""} for travel-time conflict checks.
            </p>
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

  function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div className="flex gap-2">
        <dt className="w-36 shrink-0 text-stone-400">{label}</dt>
        <dd>{children}</dd>
      </div>
    );
  }
}
