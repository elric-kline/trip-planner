import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, canEditItem, getItem, requireTripAccess } from "@/lib/scope.ts";
import { attendanceFor, myRsvp } from "@/lib/attendance.ts";
import { checkDecline, checkPropose, checkRestore, checkRsvp, checkShare, checkUnlock } from "@/lib/lifecycle.ts";
import { getLodgingDetails } from "@/lib/lodging.ts";
import { getDiningDetails } from "@/lib/dining.ts";
import { getTransportDetails, getTransportLegs } from "@/lib/transport.ts";
import { analyzeLegLayovers, transportBufferFor } from "@/lib/transport-buffer.ts";
import { dietaryWarningsForItem } from "@/lib/dietary-conflicts-for.ts";
import {
  declineItemAction,
  deleteItemAction,
  lockPrivateItemAction,
  restoreItemAction,
  saveItemAction,
  setRsvpAction,
  shareItemAction,
  unlockItemAction,
  unscheduleItemAction,
  updateTransportLegsAction,
} from "../../actions.ts";
import { canLockItem } from "@/lib/scope.ts";
import { utcToZonedInputValue } from "@/lib/time.ts";
import AddressAutocomplete from "../../AddressAutocomplete.tsx";
import DiningFields from "../../DiningFields.tsx";
import TransportLegsEditor from "../../TransportLegsEditor.tsx";
import { formatItemTime } from "../../itemDisplay.tsx";
import { DIETARY_TAG_LABEL } from "@/lib/dietary.ts";

const TRANSPORT_SUBTYPE_LABEL = {
  flight: "Flight",
  train: "Train",
  drive: "Drive",
  rideshare: "Rideshare",
  other: "Other",
} as const;

const PAYMENT_STATUS_LABEL = {
  prepaid: "Prepaid",
  partial: "Partially paid",
  pay_on_arrival: "Pay on arrival",
} as const;

/**
 * An item, read by default and edited on request.
 *
 * It used to render three always-open forms stacked on top of each other --
 * the category's booking details, the schedule, and a base title/notes editor
 * -- each with its own Save button and nothing to say which one wrote which
 * fields. On a lodging item that was thirteen empty inputs before you reached
 * anything that told you what the plan actually was, and a member who opened
 * the page to find out where they were staying got a data-entry console.
 *
 * Now: a read view, and one `?edit=1` form with a single Save (saveItemAction).
 * `?edit=1` follows the same searchParams idiom as the trip page's own tabs --
 * linkable, survives a refresh, needs no client state.
 *
 * Two things deliberately stay separate from that one Save:
 *
 * - **Lifecycle actions** (lock, unlock, decline, restore, delete, RSVP, "move
 *   back to ideas"). They change *what state the item is in*, not what it
 *   says, and each has its own rule in lifecycle.ts. Folding them into a Save
 *   would make status changes a side effect of editing a field.
 * - **Flight legs.** A variable-length set of sub-records with its own
 *   replace-all write that also resyncs the item's start/end from the first
 *   departure and last arrival -- so it would fight the schedule fields in the
 *   same form, and its per-leg `required` inputs would block saving an item
 *   that has no legs yet. Same reason an invoice's line items don't live in
 *   the invoice header's form.
 */
export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ tripId: string; itemId: string }>;
  searchParams: Promise<{ edit?: string; error?: string }>;
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

  const { edit, error } = await searchParams;

  const attendance = await attendanceFor(access, item);
  const myResponse = item.status === "locked" && item.commitment === "optional" ? await myRsvp(access, itemId) : null;
  const editable = canEditItem(access, item);
  const lodging = item.category === "lodging" ? await getLodgingDetails(itemId) : null;
  const dining = item.category === "dining" ? await getDiningDetails(itemId) : null;
  const transport = item.category === "transport" ? await getTransportDetails(itemId) : null;
  const transportLegs = transport?.subtype === "flight" ? await getTransportLegs(itemId) : [];
  const layoverFindings =
    transportLegs.length > 1 ? analyzeLegLayovers(transportLegs, transport?.international) : [];
  const dietaryFindings = dining ? await dietaryWarningsForItem(access, item, dining.accommodates) : [];
  // Purely a heads-up, not a conflict-engine finding -- earliestCheckIn
  // never feeds conflicts.ts (see schema.ts's lodgingDetails doc comment);
  // this just tells someone their planned arrival is ahead of when the
  // property says the front desk opens.
  const earliestCheckIn = lodging?.earliestCheckIn ?? null;
  const earlyArrival = earliestCheckIn && item.startsAt && item.startsAt < earliestCheckIn ? earliestCheckIn : null;

  const actor = { isPlanner: access.isPlanner, isAuthor: item.createdBy === access.viewer.id };

  /*
   * Three editability rules, and they genuinely disagree -- which is the whole
   * reason this page needs care rather than just a layout pass.
   *
   * `baseEditable` keeps the page's long-standing extra restriction: once an
   * item is locked, nobody renames it here. (canEditItem alone would let a
   * planner, so this is the page being stricter than the library on purpose;
   * unlock first if the title is wrong.)
   *
   * `detailsEditable` deliberately does NOT carry that restriction. Booking
   * details are exactly what gets corrected *after* something locks -- a
   * confirmation number that finally arrived, a check-in code.
   *
   * `scheduleAllowed` asks lifecycle.ts rather than restating its conditions.
   * The date passed in is a stand-in for "the form will supply one," since
   * checkPropose rejects a null start time and we're asking about permission,
   * not about this particular value.
   */
  const baseEditable = editable && item.status !== "locked";
  const detailsEditable =
    editable && (item.category === "lodging" || item.category === "dining" || item.category === "transport");
  const scheduleAllowed = checkPropose(item, actor, new Date()).ok;
  const anyEditable = baseEditable || detailsEditable || scheduleAllowed;
  const editing = edit === "1" && anyEditable;

  const rsvpAllowed = checkRsvp(item).ok;
  const unlockAllowed = checkUnlock(item, actor).ok;
  const shareAllowed = checkShare(item, actor).ok;
  // Decline and Restore used to render on status alone, so a member looking at
  // someone else's proposal was offered Decline as the page's only action --
  // and pressing it bounced them off the item to the trip's Agreed tab under
  // "Only the person who added this, or a planner, can decline it." Both now
  // ask the same lifecycle rule the server action enforces, like every
  // sibling action above.
  const declineAllowed = checkDecline(item, actor).ok;
  const restoreAllowed = checkRestore(item, actor).ok;
  const deleteAllowed = item.status !== "locked" && (editable || access.isPlanner);

  const timeZone = item.timezone ?? access.trip.timezone;
  const zoned = (d: Date) => utcToZonedInputValue(d, timeZone);
  const longDate = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: access.trip.timezone, dateStyle: "medium", timeStyle: "short" }).format(d);
  const memberName = (id: string) =>
    access.members.find((m) => m.userId === id)?.name ?? access.members.find((m) => m.userId === id)?.email ?? "—";

  const startLabel = item.category === "lodging" ? "Arrival" : "Starts";
  const endLabel = item.category === "lodging" ? "Departure (optional)" : "Ends (optional)";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <a href={`/trip/${tripId}`} className="inline-flex min-h-11 items-center text-sm text-stone-500 underline">
        ← Back to trip
      </a>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

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
        <p className="text-sm text-stone-500">
          {item.startsAt ? formatItemTime(item, access.trip.timezone) : "No time set yet"}
        </p>
        {item.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700">{item.notes}</p>}
        {shareAllowed && !editing && (
          <form action={shareItemAction.bind(null, tripId, itemId)} className="mt-1">
            <button type="submit" className="inline-flex min-h-11 items-center text-sm text-stone-500 underline hover:text-stone-700">
              Share to PlaySpace
            </button>
          </form>
        )}
      </div>

      {earlyArrival && (
        <Callout title="Arriving before check-in opens">
          The planned arrival is before this property&apos;s earliest check-in ({longDate(earlyArrival)}) — you may
          need to store bags or wait.
        </Callout>
      )}

      {dietaryFindings.length > 0 && (
        <Callout title={`May not work for ${dietaryFindings.length === 1 ? "someone on this" : "everyone on this"}`}>
          <ul className="space-y-1">
            {dietaryFindings.map((f, i) => (
              <li key={i}>
                <strong>{f.member.name ?? f.member.email}</strong> —{" "}
                {f.unmetTags.map((t) => DIETARY_TAG_LABEL[t]).join(", ")}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {layoverFindings.some((f) => f.tight) && (
        <Callout title="Tight connection">
          {layoverFindings
            .filter((f) => f.tight)
            .map((f, i) => (
              <p key={i}>
                Only {Math.round(f.layoverMinutes)} min between legs — under the {f.minimumMinutes} min minimum
                connection time.
              </p>
            ))}
        </Callout>
      )}

      {editing ? (
        /* ---------------------------------------------------------------
         * One form, one Save. Each hidden marker says only which section was
         * rendered; saveItemAction still runs every write through the same
         * library call that enforced it before, so a marker can narrow what
         * gets written but never widen who may write it.
         * ------------------------------------------------------------- */
        <form action={saveItemAction.bind(null, tripId, itemId)} className="space-y-6">
          {baseEditable && <input type="hidden" name="editsBase" value="1" />}
          {scheduleAllowed && <input type="hidden" name="editsSchedule" value="1" />}
          {detailsEditable && <input type="hidden" name="detailsFor" value={item.category} />}

          {baseEditable ? (
            <Panel title="Basics">
              <div className="grid gap-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">Title</span>
                  <input name="title" defaultValue={item.title} required className="input" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">Category</span>
                  <select name="category" defaultValue={item.category} className="input">
                    <option value="lodging">Lodging</option>
                    <option value="dining">Dining</option>
                    <option value="activity">Activity</option>
                    <option value="transport">Transport</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                {/* Lodging asks once, under its own name. The page used to have
                    both a "Location" here and an "Address" in the lodging
                    block, each with its own paragraph about which one
                    geocoding used. */}
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">
                    {item.category === "lodging" ? "Address" : "Location"}
                  </span>
                  <AddressAutocomplete
                    name={item.category === "lodging" ? "address" : "locationName"}
                    defaultValue={item.category === "lodging" ? (lodging?.address ?? item.locationName) : item.locationName}
                    className="input"
                    placeholder={item.category === "lodging" ? "Where you're staying" : "Where this happens"}
                  />
                  <span className="mt-1 block text-sm text-stone-500">
                    Coordinates are looked up from this automatically, for travel-time conflict checks.
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">Notes</span>
                  <textarea name="notes" defaultValue={item.notes ?? ""} className="input" rows={3} />
                </label>
              </div>
            </Panel>
          ) : (
            detailsEditable && (
              <p className="rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-600">
                This item is locked, so its title, category and schedule are fixed. Booking details below can still
                be corrected — unlock it first to change anything else.
              </p>
            )
          )}

          {scheduleAllowed && (
            <Panel title={item.category === "lodging" ? "Arrival / departure" : "Schedule"}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">{startLabel}</span>
                  <input
                    type="datetime-local"
                    name="startsAt"
                    defaultValue={item.startsAt ? zoned(item.startsAt) : ""}
                    className="input"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">{endLabel}</span>
                  <input
                    type="datetime-local"
                    name="endsAt"
                    defaultValue={item.endsAt ? zoned(item.endsAt) : ""}
                    className="input"
                  />
                </label>
              </div>
              <p className="mt-2 text-sm text-stone-500">
                {item.category === "lodging"
                  ? "When you actually plan to show up and leave — this is what travel-time conflict checks use, not the property's own check-in policy."
                  : "Giving an idea a time moves it to a proposal."}
              </p>
            </Panel>
          )}

          {detailsEditable && item.category === "lodging" && (
            <Panel title="Lodging details">
              <div className="grid gap-3">
                {/* Only when the Basics panel above isn't rendering it. A
                    locked lodging item still needs a correctable address --
                    that's been true all along (the old lodging form was never
                    gated on "not locked"), and losing it would be a real
                    capability regression rather than a tidy-up. saveItemAction
                    syncs the item's own location from it in that case. */}
                {!baseEditable && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-stone-700">Address</span>
                    <AddressAutocomplete
                      name="address"
                      defaultValue={lodging?.address ?? item.locationName}
                      placeholder="Where you're staying"
                      className="input"
                    />
                  </label>
                )}
                <textarea
                  name="checkInInstructions"
                  defaultValue={lodging?.checkInInstructions ?? ""}
                  placeholder="Check-in instructions (e.g. lockbox code, self check-in)"
                  className="input"
                  rows={2}
                />
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">Earliest check-in (optional)</span>
                  <input
                    type="datetime-local"
                    name="earliestCheckIn"
                    defaultValue={lodging?.earliestCheckIn ? zoned(lodging.earliestCheckIn) : ""}
                    className="input"
                  />
                  <span className="mt-1 block text-sm text-stone-500">
                    The property&apos;s own policy, e.g. front desk opens at 3 PM — informational only.
                  </span>
                </label>
                <input name="contactName" defaultValue={lodging?.contactName ?? ""} placeholder="Contact name (optional)" className="input" />
                <input name="contactPhone" defaultValue={lodging?.contactPhone ?? ""} placeholder="Contact phone" className="input" />
                <input name="contactEmail" type="email" defaultValue={lodging?.contactEmail ?? ""} placeholder="Contact email" className="input" />
                <input name="confirmationNumber" defaultValue={lodging?.confirmationNumber ?? ""} placeholder="Confirmation number" className="input" />
                <select name="bookedBy" defaultValue={lodging?.bookedBy ?? ""} className="input">
                  <option value="">Booked under (optional)</option>
                  {access.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </select>
                <select name="paymentStatus" defaultValue={lodging?.paymentStatus ?? ""} className="input">
                  <option value="">Payment status</option>
                  <option value="prepaid">Prepaid</option>
                  <option value="partial">Partially paid</option>
                  <option value="pay_on_arrival">Pay on arrival</option>
                </select>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input name="costAmount" type="number" step="any" defaultValue={lodging?.costAmount ?? ""} placeholder="Cost" className="input" />
                  <input name="costCurrency" defaultValue={lodging?.costCurrency ?? ""} placeholder="Currency (e.g. USD)" className="input" maxLength={8} />
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block text-stone-700">Cancel by (optional)</span>
                  <input
                    type="datetime-local"
                    name="cancellationDeadline"
                    defaultValue={lodging?.cancellationDeadline ? zoned(lodging.cancellationDeadline) : ""}
                    className="input"
                  />
                </label>
                <input name="bookingUrl" type="url" defaultValue={lodging?.bookingUrl ?? ""} placeholder="Booking link (optional)" className="input" />
              </div>
            </Panel>
          )}

          {detailsEditable && item.category === "dining" && (
            <Panel title="Dining details">
              <DiningFields
                itemTitle={item.title}
                destination={access.trip.destination}
                dining={dining}
                members={access.members}
              />
            </Panel>
          )}

          {detailsEditable && item.category === "transport" && (
            <Panel title="Transport details">
              <div className="grid gap-3">
                <select name="subtype" defaultValue={transport?.subtype ?? "other"} className="input">
                  {Object.entries(TRANSPORT_SUBTYPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {(transport?.subtype ?? "other") === "flight" ? (
                  <label className="flex min-h-11 items-center gap-2 text-sm text-stone-700">
                    <input type="checkbox" name="international" defaultChecked={transport?.international ?? false} />
                    International
                  </label>
                ) : (
                  <>
                    <AddressAutocomplete
                      name="destinationName"
                      defaultValue={transport?.destinationName}
                      placeholder="Destination (optional)"
                      className="input"
                    />
                    <p className="-mt-2 text-sm text-stone-500">
                      Where this trip ends up, if different from Location — lets the conflict checker estimate
                      travel from here, not from where it started.
                    </p>
                  </>
                )}
                <input name="confirmationNumber" defaultValue={transport?.confirmationNumber ?? ""} placeholder="Confirmation number" className="input" />
                <select name="bookedBy" defaultValue={transport?.bookedBy ?? ""} className="input">
                  <option value="">Booked under (optional)</option>
                  {access.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </select>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input name="costAmount" type="number" step="any" defaultValue={transport?.costAmount ?? ""} placeholder="Cost" className="input" />
                  <input name="costCurrency" defaultValue={transport?.costCurrency ?? ""} placeholder="Currency (e.g. USD)" className="input" maxLength={8} />
                </div>
                <input name="bookingUrl" type="url" defaultValue={transport?.bookingUrl ?? ""} placeholder="Booking link (optional)" className="input" />
              </div>
            </Panel>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary">
              Save changes
            </button>
            <a
              href={`/trip/${tripId}/items/${itemId}`}
              className="inline-flex min-h-11 items-center text-sm text-stone-500 underline hover:text-stone-700"
            >
              Cancel
            </a>
          </div>
        </form>
      ) : (
        <>
          {lodging && hasLodgingContent(lodging) && (
            <Panel title="Lodging details">
              <dl className="space-y-1.5 text-sm text-stone-700">
                {lodging.address && <Field label="Address">{lodging.address}</Field>}
                {lodging.checkInInstructions && (
                  <Field label="Check-in instructions">
                    <span className="whitespace-pre-wrap">{lodging.checkInInstructions}</span>
                  </Field>
                )}
                {lodging.earliestCheckIn && <Field label="Earliest check-in">{longDate(lodging.earliestCheckIn)}</Field>}
                {(lodging.contactName || lodging.contactPhone || lodging.contactEmail) && (
                  <Field label="Contact">
                    {[lodging.contactName, lodging.contactPhone, lodging.contactEmail].filter(Boolean).join(" · ")}
                  </Field>
                )}
                {lodging.confirmationNumber && <Field label="Confirmation #">{lodging.confirmationNumber}</Field>}
                {lodging.bookedBy && <Field label="Booked under">{memberName(lodging.bookedBy)}</Field>}
                {(lodging.paymentStatus || lodging.costAmount != null) && (
                  <Field label="Payment">
                    {lodging.paymentStatus ? PAYMENT_STATUS_LABEL[lodging.paymentStatus] : ""}
                    {lodging.costAmount != null && ` — ${lodging.costAmount} ${lodging.costCurrency ?? ""}`.trim()}
                  </Field>
                )}
                {lodging.cancellationDeadline && <Field label="Cancel by">{longDate(lodging.cancellationDeadline)}</Field>}
                {lodging.bookingUrl && (
                  <Field label="Booking link">
                    <a href={lodging.bookingUrl} className="link break-all">
                      {lodging.bookingUrl}
                    </a>
                  </Field>
                )}
              </dl>
            </Panel>
          )}

          {dining && hasDiningContent(dining) && (
            <Panel title="Dining details">
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
                {dining.confirmationNumber && <Field label="Confirmation #">{dining.confirmationNumber}</Field>}
                {dining.reservedBy && <Field label="Reserved under">{memberName(dining.reservedBy)}</Field>}
                {dining.reservationUrl && (
                  <Field label="Reservation link">
                    <a href={dining.reservationUrl} className="link break-all">
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
            </Panel>
          )}

          {transport && (
            <Panel title="Transport details">
              <dl className="space-y-1.5 text-sm text-stone-700">
                <Field label="Type">
                  {TRANSPORT_SUBTYPE_LABEL[transport.subtype]}
                  {transport.subtype === "flight" && transport.international ? " (international)" : ""}
                </Field>
                {transport.subtype !== "flight" && transport.destinationName && (
                  <Field label="Destination">{transport.destinationName}</Field>
                )}
                {transport.confirmationNumber && <Field label="Confirmation #">{transport.confirmationNumber}</Field>}
                {transport.bookedBy && <Field label="Booked under">{memberName(transport.bookedBy)}</Field>}
                {transport.costAmount != null && (
                  <Field label="Cost">
                    {transport.costAmount} {transport.costCurrency ?? ""}
                  </Field>
                )}
                {transport.bookingUrl && (
                  <Field label="Booking link">
                    <a href={transport.bookingUrl} className="link break-all">
                      {transport.bookingUrl}
                    </a>
                  </Field>
                )}
              </dl>
              {(() => {
                const buffer = transportBufferFor(transport.subtype, transport.international);
                if (buffer.preMinutes === 0 && buffer.postMinutes === 0) return null;
                return (
                  <p className="mt-3 text-sm text-stone-500">
                    When checking for conflicts, this adds {buffer.preMinutes > 0 && `${buffer.preMinutes} min before`}
                    {buffer.preMinutes > 0 && buffer.postMinutes > 0 && " and "}
                    {buffer.postMinutes > 0 && `${buffer.postMinutes} min after`} its own start/end time.
                  </p>
                );
              })()}
            </Panel>
          )}

          {transportLegs.length > 0 && (
            <Panel title="Flight legs">
              <ol className="space-y-2 text-sm text-stone-700">
                {transportLegs.map((leg, i) => (
                  <li key={leg.id} className="rounded-md border border-stone-100 bg-stone-50 p-2">
                    <p className="font-medium">
                      Leg {i + 1}
                      {leg.flightNumber ? ` — ${leg.flightNumber}` : ""}
                      {leg.airline ? ` (${leg.airline})` : ""}
                    </p>
                    <p className="text-stone-500">
                      {leg.departureAirport ?? "?"} → {leg.arrivalAirport ?? "?"} · {longDate(leg.departsAt)} →{" "}
                      {new Intl.DateTimeFormat("en-US", { timeZone, timeStyle: "short" }).format(leg.arrivesAt)}
                    </p>
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          {item.status === "locked" && (
            <Panel title={`Who's ${item.commitment === "required" ? "on this" : "in"}`}>
              {item.visibility === "private" ? (
                <p className="text-sm text-stone-500">Just you.</p>
              ) : item.commitment === "required" ? (
                <p className="text-sm text-stone-500">Everyone on the trip — this is required.</p>
              ) : (
                <div className="space-y-1 text-sm">
                  <p className="text-stone-600">
                    Yes: {attendance.attendees.map((m) => m.name ?? m.email).join(", ") || "—"}
                  </p>
                  <p className="text-stone-500">
                    Awaiting: {attendance.awaiting.map((m) => m.name ?? m.email).join(", ") || "—"}
                  </p>
                  {attendance.declined.length > 0 && (
                    <p className="text-stone-500">
                      No: {attendance.declined.map((m) => m.name ?? m.email).join(", ")}
                    </p>
                  )}
                </div>
              )}

              {rsvpAllowed && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["yes", "maybe", "no"] as const).map((r) => (
                    <form key={r} action={setRsvpAction.bind(null, tripId, itemId, r)}>
                      <button className={myResponse === r ? "btn-primary" : "btn-secondary"}>
                        {r === "yes" ? "I'm in" : r === "maybe" ? "Maybe" : "Can't make it"}
                      </button>
                    </form>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {/* Lifecycle actions -- deliberately not part of the Save above. */}
          <section className="flex flex-wrap items-center gap-3">
            {anyEditable && (
              <a href={`/trip/${tripId}/items/${itemId}?edit=1`} className="btn-primary">
                Edit
              </a>
            )}
            {item.status === "proposed" && canLockItem(access) && item.visibility === "group" && (
              <a href={`/trip/${tripId}/items/${itemId}/lock`} className="btn-secondary">
                Lock this in →
              </a>
            )}
            {item.status === "proposed" && item.visibility === "private" && actor.isAuthor && (
              <form action={lockPrivateItemAction.bind(null, tripId, itemId)}>
                <button className="btn-secondary">Lock in my private plan</button>
              </form>
            )}
            {unlockAllowed && (
              <form action={unlockItemAction.bind(null, tripId, itemId)}>
                <button className="btn-secondary">Unlock</button>
              </form>
            )}
            {item.status === "proposed" && scheduleAllowed && (
              <form action={unscheduleItemAction.bind(null, tripId, itemId)}>
                <button className="inline-flex min-h-11 items-center text-sm text-stone-500 underline hover:text-stone-700">
                  Move back to ideas
                </button>
              </form>
            )}
            {restoreAllowed && (
              <form action={restoreItemAction.bind(null, tripId, itemId)}>
                <button className="btn-secondary">Restore</button>
              </form>
            )}
            {declineAllowed && (
              <form action={declineItemAction.bind(null, tripId, itemId)}>
                <button className="btn-secondary">Decline</button>
              </form>
            )}
            {deleteAllowed && (
              <form action={deleteItemAction.bind(null, tripId, itemId)}>
                <button className="inline-flex min-h-11 items-center text-sm text-red-600 underline">Delete</button>
              </form>
            )}
          </section>
        </>
      )}

      {/* Its own form for the reason given at the top of this file: a
          replace-all set of sub-records that also rewrites the item's own
          start/end. Shown while editing, so the read view stays read-only. */}
      {editing && transport?.subtype === "flight" && detailsEditable && (
        <Panel title="Flight legs">
          <p className="mb-3 text-sm text-stone-500">
            Legs save on their own — the button below writes them straight away, separately from Save changes above.
          </p>
          <TransportLegsEditor
            action={updateTransportLegsAction.bind(null, tripId, itemId)}
            legs={transportLegs}
            timeZone={timeZone}
          />
        </Panel>
      )}
    </div>
  );

  function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <section className="rounded-md border border-stone-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-stone-700">{title}</h2>
        {children}
      </section>
    );
  }

  function Callout({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="mb-1 text-sm font-medium text-amber-900">{title}</p>
        <div className="text-sm text-amber-800">{children}</div>
      </div>
    );
  }

  function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
        <dt className="shrink-0 text-stone-500 sm:w-36">{label}</dt>
        <dd>{children}</dd>
      </div>
    );
  }
}

/** Whether there's anything worth rendering a read-view panel for. */
function hasLodgingContent(l: NonNullable<Awaited<ReturnType<typeof getLodgingDetails>>>): boolean {
  return Boolean(
    l.address ||
      l.checkInInstructions ||
      l.earliestCheckIn ||
      l.contactName ||
      l.contactPhone ||
      l.contactEmail ||
      l.confirmationNumber ||
      l.bookedBy ||
      l.paymentStatus ||
      l.costAmount != null ||
      l.cancellationDeadline ||
      l.bookingUrl,
  );
}

function hasDiningContent(d: NonNullable<Awaited<ReturnType<typeof getDiningDetails>>>): boolean {
  return Boolean(
    d.cuisine ||
      d.accommodates?.length ||
      d.partySize != null ||
      d.priceRange ||
      d.contactPhone ||
      d.confirmationNumber ||
      d.reservedBy ||
      d.reservationUrl ||
      d.specialRequests,
  );
}
