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
  unlockItem,
  unscheduleItem,
  updateItemDetails,
  RuleError,
} from "@/lib/items.ts";
import { upsertLodgingDetails, type LodgingDetailsInput, type LodgingPaymentStatus } from "@/lib/lodging.ts";
import type { Commitment } from "@/lib/lifecycle.ts";
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

export async function createItemAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  const category = (formData.get("category") as Item["category"] | "") || "activity";

  try {
    const created = await createItem(access, {
      title: String(formData.get("title") ?? ""),
      notes: String(formData.get("notes") ?? "") || null,
      category,
      locationName: String(formData.get("locationName") ?? "") || null,
      locationLat: toNumberOrNull(formData.get("locationLat")),
      locationLng: toNumberOrNull(formData.get("locationLng")),
      visibility: formData.get("private") === "on" ? "private" : "group",
      startsAt: localInputToDate(formData.get("startsAt"), access.trip.timezone),
      endsAt: localInputToDate(formData.get("endsAt"), access.trip.timezone),
    });

    if (category === "lodging") {
      const lodging = parseLodgingFields(formData, access.trip.timezone);
      if (Object.values(lodging).some((v) => v !== null)) {
        await upsertLodgingDetails(access, created.id, lodging);
      }
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
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
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
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
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
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
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
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
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
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
}

export async function updateItemAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  try {
    await updateItemDetails(access, itemId, {
      title: String(formData.get("title") ?? ""),
      notes: String(formData.get("notes") ?? "") || null,
      category: (formData.get("category") as Item["category"] | "") || undefined,
      locationName: String(formData.get("locationName") ?? "") || null,
      locationLat: toNumberOrNull(formData.get("locationLat")),
      locationLng: toNumberOrNull(formData.get("locationLng")),
    });
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}`);
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
}

export async function updateLodgingDetailsAction(
  tripId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);

  try {
    await upsertLodgingDetails(access, itemId, parseLodgingFields(formData, access.trip.timezone));
  } catch (err) {
    withError(tripId, err);
  }
  revalidatePath(`/trip/${tripId}/items/${itemId}`);
}

export async function createInviteAction(tripId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const access = await requireTripAccess(tripId, user);
  if (!access.isPlanner) withError(tripId, new Error("Only a Master Planner can send invites."));

  const email = String(formData.get("email") ?? "").trim() || undefined;
  const invite = await createInvite(tripId, user, { email });

  redirect(`/trip/${tripId}?invite=${invite.token}`);
}
