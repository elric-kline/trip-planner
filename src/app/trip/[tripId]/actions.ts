"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { requireTripAccess, type Item } from "@/lib/scope.ts";
import { createInvite } from "@/lib/trips.ts";
import {
  createItem,
  declineItem,
  deleteItem,
  lockItem,
  restoreItem,
  scheduleItem,
  setRsvp,
  shareItem,
  unlockItem,
  unscheduleItem,
  updateItemDetails,
  RuleError,
} from "@/lib/items.ts";
import { upsertLodgingDetails, type LodgingDetailsInput, type LodgingPaymentStatus } from "@/lib/lodging.ts";
import { upsertDiningDetails, type DiningDetailsInput, type DiningPriceRange } from "@/lib/dining.ts";
import {
  upsertTransportDetails,
  setTransportLegs,
  type TransportDetailsInput,
  type TransportLegInput,
  type TransportSubtype,
} from "@/lib/transport.ts";
import {
  addLocation,
  moveLocation,
  removeLocation,
  renameLocation,
  setLocationMembers,
  type DayLocationKind,
} from "@/lib/days.ts";
import { geocodeAddress } from "@/lib/geocode.ts";
import type { Commitment } from "@/lib/lifecycle.ts";
import type { DietaryTag } from "@/lib/dietary.ts";
import { zonedInputToUtc } from "@/lib/time.ts";

/**
 * `datetime-local` inputs carry no timezone of their own — the value is only
 * meaningful once you know whose clock it's read from. We always read it as
 * the trip's destination time (there's no per-item override UI yet, though
 * the schema leaves room for one), never the server process's own timezone.
 */
function localInputToDate(value: FormDataEntryValue | null, timeZone: string): Date | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  return zonedInputToUtc(s, timeZone);
}

function toNumberOrNull(value: FormDataEntryValue | null): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Nobody types coordinates by hand anymore — we look them up from whatever
 * location text they gave us. A failed or skipped lookup (no API key, an
 * address Google can't resolve) just means the conflict engine can't
 * estimate travel time for this item; it never blocks saving.
 */
async function geocode(query: string | null | undefined): Promise<{ lat: number; lng: number } | null> {
  if (!query) return null;
  return geocodeAddress(query);
}

/** Redirects back to the trip with an error banner instead of crashing the request. */
function withError(tripId: string, err: unknown): never {
  const message = err instanceof RuleError || err instanceof Error ? err.message : "Something went wrong.";
  redirect(`/trip/${tripId}?error=${encodeURIComponent(message)}`);
}

/**
 * Shared by the quick "Add something" form (fields shown inline as soon as
 * Lodging is picked, before the item exists) and the item detail page's
 * lodging edit form — same field names, same parsing either way.
 */
function parseLodgingFields(formData: FormData, timeZone: string): LodgingDetailsInput {
  const str = (name: string) => String(formData.get(name) ?? "").trim() || null;
  return {
    address: str("address"),
    checkInInstructions: str("checkInInstructions"),
    contactName: str("contactName"),
    contactPhone: str("contactPhone"),
    contactEmail: str("contactEmail"),
    confirmationNumber: str("confirmationNumber"),
    bookedBy: str("bookedBy"),
    paymentStatus: (formData.get("paymentStatus") as LodgingPaymentStatus | "") || null,
    bookingUrl: str("bookingUrl"),
    cancellationDeadline: localInputToDate(formData.get("cancellationDeadline"), timeZone),
    costAmount: toNumberOrNull(formData.get("costAmount")),
    costCurrency: str("costCurrency"),
  };
}

/** Shared by the "Add something" form and the item detail page's dining edit form, same as parseLodgingFields. */
function parseDiningFields(formData: FormData): DiningDetailsInput {
  const str = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const tags = formData.getAll("accommodates") as DietaryTag[];
  const partySize = toNumberOrNull(formData.get("partySize"));
  return {
    placeId: str("placeId"),
    cuisine: str("cuisine"),
    accommodates: tags.length ? tags : null,
    partySize: partySize != null ? Math.trunc(partySize) : null,
    priceRange: (formData.get("priceRange") as DiningPriceRange | "") || null,
    reservedBy: str("reservedBy"),
    confirmationNumber: str("confirmationNumber"),
    contactPhone: str("contactPhone"),
    reservationUrl: str("reservationUrl"),
    specialRequests: str("specialRequests"),
  };
}

/** True when at least one field was actually filled in — an all-empty form shouldn't create a details row at all. */
function hasAnyValue(input: Record<string, unknown>): boolean {
  return Object.values(input).some((v) => v !== null && !(Array.isArray(v) && v.length === 0));
}

/**
 * Shared by the quick "Add something" form and the item detail page's
 * transport edit form, same as parseLodgingFields/parseDiningFields --
 * except subtype is always saved (never gated behind hasAnyValue) since
 * it's a NOT NULL column, not an optional detail.
 */
function parseTransportFields(formData: FormData): TransportDetailsInput {
  const str = (name: string) => String(formData.get(name) ?? "").trim() || null;
  return {
    subtype: (formData.get("subtype") as TransportSubtype) || "other",
    international: formData.get("international") === "on",
    confirmationNumber: str("confirmationNumber"),
    bookedBy: str("bookedBy"),
    bookingUrl: str("bookingUrl"),
    costAmount: toNumberOrNull(formData.get("costAmount")),
    costCurrency: str("costCurrency"),
    destinationName: str("destinationName"),
  };
}

/**
 * Geocodes `transport.destinationName` (a drive/rideshare/train's own
 * endpoint -- irrelevant for a flight, which gets its destination from its
 * legs instead) and attaches the result, same "re-geocode from whatever
 * text is there now" approach as the item's own Location field. A failed
 * or skipped lookup just leaves destinationLat/Lng null -- conflict
 * analysis can't reason about what comes after this item, same as if the
 * field had been left blank.
 */
async function withGeocodedDestination(transport: TransportDetailsInput): Promise<TransportDetailsInput> {
  const coords = await geocode(transport.destinationName);
  return { ...transport, destinationLat: coords?.lat ?? null, destinationLng: coords?.lng ?? null };
}

/**
 * Repeated same-name inputs across TransportLegsEditor's rows -- getAll
 * returns them in document order, so index i across every field belongs to
 * the same row. A row whose departs/arrives never got filled in (an "Add
 * another leg" row left blank) is dropped rather than saved as invalid.
 */
function parseTransportLegs(formData: FormData, timeZone: string): TransportLegInput[] {
  const str = (name: string) => formData.getAll(name).map((v) => String(v).trim() || null);
  const airlines = str("airline");
  const flightNumbers = str("flightNumber");
  const departureAirports = str("departureAirport");
  const arrivalAirports = str("arrivalAirport");
  const departsAtValues = formData.getAll("departsAt");
  const arrivesAtValues = formData.getAll("arrivesAt");

  const legs: TransportLegInput[] = [];
  for (let i = 0; i < departsAtValues.length; i++) {
    const departsAt = localInputToDate(departsAtValues[i], timeZone);
    const arrivesAt = localInputToDate(arrivesAtValues[i], timeZone);
    if (!departsAt || !arrivesAt) continue;
    legs.push({
      airline: airlines[i] ?? null,
      flightNumber: flightNumbers[i] ?? null,
      departureAirport: departureAirports[i] ?? null,
      arrivalAirport: arrivalAirports[i] ?? null,
      departsAt,
      arrivesAt,
    });
  }
  return legs;
}

export async function createItemAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const category = (formData.get("category") as Item["category"] | "") || "activity";
  const locationName = String(formData.get("locationName") ?? "") || null;
  const lodging = category === "lodging" ? parseLodgingFields(formData, access.trip.timezone) : null;
  const dining = category === "dining" ? parseDiningFields(formData) : null;
  const transport =
    category === "transport" ? await withGeocodedDestination(parseTransportFields(formData)) : null;

  // A lodging item's real location is its address, not the free-text
  // "Location" label — prefer that for the lookup when both are given.
  // Dining has no separate address field -- the restaurant's location *is*
  // the "Location" field (a future restaurant-search step fills it in).
  const coords = await geocode(lodging?.address ?? locationName);

  // Present only when this form was opened from a day's own "+ Add" slot
  // (see DayItemBuilder.tsx) -- the trip-wide "Add something" form at the
  // bottom of the page has neither, and creates an ungrounded idea same as
  // always.
  const dayId = String(formData.get("dayId") ?? "") || null;
  const afterItemId = String(formData.get("afterItemId") ?? "") || undefined;

  try {
    const created = await createItem(access, {
      title: String(formData.get("title") ?? ""),
      notes: String(formData.get("notes") ?? "") || null,
      category,
      locationName,
      locationLat: coords?.lat ?? null,
      locationLng: coords?.lng ?? null,
      visibility: formData.get("private") === "on" ? "private" : "group",
      startsAt: localInputToDate(formData.get("startsAt"), access.trip.timezone),
      endsAt: localInputToDate(formData.get("endsAt"), access.trip.timezone),
      dayId,
      afterItemId,
    });

    if (lodging && hasAnyValue(lodging)) {
      await upsertLodgingDetails(access, created.id, lodging);
    }
    if (dining && hasAnyValue(dining)) {
      await upsertDiningDetails(access, created.id, dining);
    }
    // Always saved (not gated by hasAnyValue) once transport is picked --
    // subtype is a required column, not an optional detail.
    if (transport) {
      await upsertTransportDetails(access, created.id, transport);
    }
  } catch (err) {
    withError(tripId, err);
  }

  revalidatePath(`/trip/${tripId}`);
}

export async function scheduleItemAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const startsAt = localInputToDate(formData.get("startsAt"), access.trip.timezone);
  if (!startsAt) withError(tripId, new Error("Give the item a start time."));

  try {
    await scheduleItem(
      access,
      itemId,
      startsAt!,
      localInputToDate(formData.get("endsAt"), access.trip.timezone),
    );
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function unscheduleItemAction(tripId: string, itemId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await unscheduleItem(access, itemId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function lockItemAction(
  tripId: string,
  itemId: string,
  commitment: Commitment | null,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await lockItem(access, itemId, commitment);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

/** A private item has no commitment to choose — its author just locks it in. */
export async function lockPrivateItemAction(tripId: string, itemId: string): Promise<void> {
  await lockItemAction(tripId, itemId, null);
}

export async function unlockItemAction(tripId: string, itemId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await unlockItem(access, itemId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function declineItemAction(tripId: string, itemId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await declineItem(access, itemId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

/**
 * Moves an item from Scratchpad to PlaySpace -- see items.ts's shareItem.
 * Deliberately no redirect, unlike its neighbors here: this one form is
 * shared by two different pages (the trip page's own Scratchpad list, and
 * the item detail page's "Share to PlaySpace" link -- see ScratchpadList
 * in page.tsx). A hardcoded redirect target would be right for one and
 * wrong for the other, so this stays revalidatePath-only; the item detail
 * page's own copy of the button lives inside a page that gets a full
 * redirect-driven refresh from every *other* action on it, so its stale-
 * until-reload window is just this one link.
 */
export async function shareItemAction(tripId: string, itemId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await shareItem(access, itemId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
}

export async function restoreItemAction(tripId: string, itemId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await restoreItem(access, itemId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function deleteItemAction(tripId: string, itemId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await deleteItem(access, itemId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}`);
}

export async function setRsvpAction(
  tripId: string,
  itemId: string,
  response: "yes" | "no" | "maybe",
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await setRsvp(access, itemId, response);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function updateItemAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const locationName = String(formData.get("locationName") ?? "") || null;
  // Only re-geocode when a lookup actually succeeds — a failed or skipped
  // one (address didn't change, or Google couldn't resolve it) shouldn't
  // wipe out coordinates that were already there.
  const coords = await geocode(locationName);

  try {
    await updateItemDetails(access, itemId, {
      title: String(formData.get("title") ?? ""),
      notes: String(formData.get("notes") ?? "") || null,
      category: (formData.get("category") as Item["category"] | "") || undefined,
      locationName,
      ...(coords ? { locationLat: coords.lat, locationLng: coords.lng } : {}),
    });
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function updateLodgingDetailsAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const lodging = parseLodgingFields(formData, access.trip.timezone);
  const coords = await geocode(lodging.address);

  try {
    await upsertLodgingDetails(access, itemId, lodging);
    // The address is the item's real location for conflict-checking
    // purposes — keep the item's own locationName/coordinates in sync with
    // it, same as at creation time.
    if (lodging.address) {
      await updateItemDetails(access, itemId, {
        locationName: lodging.address,
        ...(coords ? { locationLat: coords.lat, locationLng: coords.lng } : {}),
      });
    }
  } catch (err) {
    withError(tripId, err);
  }
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function updateDiningDetailsAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const dining = parseDiningFields(formData);

  try {
    await upsertDiningDetails(access, itemId, dining);
  } catch (err) {
    withError(tripId, err);
  }
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function updateTransportDetailsAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const transport = await withGeocodedDestination(parseTransportFields(formData));

  try {
    await upsertTransportDetails(access, itemId, transport);
  } catch (err) {
    withError(tripId, err);
  }
  redirect(`/trip/${tripId}/items/${itemId}`);
}

/**
 * Replace-all for a flight's legs -- see transport.ts's setTransportLegs.
 * Also revalidates the trip page, not just the item's own, since saving
 * legs can move the item's startsAt/endsAt (and so its position in the
 * day's timeline).
 *
 * Each leg's arrival airport gets geocoded here (" airport" appended --
 * Google resolves e.g. "SEA airport" far more reliably than the bare IATA
 * code) so conflict analysis knows where the traveler actually lands, not
 * just where the item's own generic Location field says it started -- see
 * conflicts.ts's ScheduleItem.destinationLocation. A failed or skipped
 * lookup just leaves that leg's arrival coordinates null; setTransportLegs
 * still saves the leg, the conflict checker just can't reason about what
 * comes after it.
 */
export async function updateTransportLegsAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const parsedLegs = parseTransportLegs(formData, access.trip.timezone);
  const legs = await Promise.all(
    parsedLegs.map(async (leg) => {
      const coords = leg.arrivalAirport ? await geocode(`${leg.arrivalAirport} airport`) : null;
      return { ...leg, arrivalLat: coords?.lat ?? null, arrivalLng: coords?.lng ?? null };
    }),
  );

  try {
    await setTransportLegs(access, itemId, legs);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  redirect(`/trip/${tripId}/items/${itemId}`);
}

export async function createInviteAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  if (!access.isPlanner) withError(tripId, new Error("Only a Master Planner can send invites."));

  const email = String(formData.get("email") ?? "").trim() || undefined;
  const invite = await createInvite(tripId, user, { email });

  redirect(`/trip/${tripId}?invite=${invite.token}`);
}

/** The "includes" checkboxes on a location's own form -- see days.ts's setLocationMembers. */
function includedMemberIds(formData: FormData): string[] {
  return formData.getAll("includes").map((v) => String(v));
}

/**
 * Shared by setWakeLocationAction/setSleepLocationAction/addStopAction:
 * geocodes the form's name field, saves the location via whichever
 * days.ts call the caller needs, then applies whichever members the
 * form's own "Includes" checkboxes had checked -- skipped if the location
 * ended up deleted (a blank wake/sleep name) since there's nothing left to
 * set membership on.
 */
/**
 * Adds a wake, sleep, or stop location to a day. A single generic action
 * (not addWakeLocationAction/addSleepLocationAction/addStopAction) because
 * they're all the same operation on the same list, differing only in
 * `kind` -- see days.ts's addLocation.
 */
export async function addLocationAction(
  tripId: string,
  dayId: string,
  kind: DayLocationKind,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const name = String(formData.get("name") ?? "");
  const coords = await geocode(name);

  try {
    const created = await addLocation(access, dayId, kind, {
      name,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    });
    await setLocationMembers(access, created.id, includedMemberIds(formData));
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
}

/**
 * Edits an existing location's name and its Includes together, in one
 * submit -- e.g. splitting a combined entry like "PA/NYC" down to just
 * "PA" so "NYC" can be added alongside it as its own location. See
 * days.ts's renameLocation.
 */
export async function updateLocationAction(tripId: string, locationId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const name = String(formData.get("name") ?? "");
  const coords = await geocode(name);

  try {
    await renameLocation(access, locationId, { name, lat: coords?.lat ?? null, lng: coords?.lng ?? null });
    await setLocationMembers(access, locationId, includedMemberIds(formData));
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
}

export async function removeLocationAction(tripId: string, locationId: string): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await removeLocation(access, locationId);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
}

export async function moveLocationAction(
  tripId: string,
  locationId: string,
  direction: "up" | "down",
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await moveLocation(access, locationId, direction);
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
}

