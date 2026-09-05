import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { items, photos, users } from "@/db/schema";
import { getItem, type TripAccess } from "./scope.ts";
import { getDay } from "./days.ts";
import { RuleError } from "./items.ts";
import {
  deleteObject,
  deleteObjects,
  isStorageConfigured,
  objectKeyFor,
  putObject,
  signedGetUrl,
} from "./r2.ts";

/**
 * The photo journal. A photo always belongs to a trip; it can additionally
 * be pinned to a specific day, or to a specific itinerary item. Anyone on
 * the trip can upload; any member can see the trip's photos; a photo can
 * be deleted by its uploader or by a planner (same rule as itemComments).
 *
 * Bytes live in Cloudflare R2 (see lib/r2.ts). This module owns the read
 * path too: view URLs are always minted through `viewablePhotoUrl` so
 * every render has just been through the trip-scope check. Callers never
 * touch `photos.storageKey` directly.
 */

export type PhotoScope = "trip" | "day" | "item";

export type Photo = {
  id: string;
  tripId: string;
  scope: PhotoScope;
  dayId: string | null;
  itemId: string | null;
  uploadedBy: string;
  uploaderName: string | null;
  uploaderEmail: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  capturedAt: Date | null;
  createdAt: Date;
};

const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB -- generous for a phone shot after client-side resize; larger will be refused rather than silently truncated.
const MAX_CAPTION_LENGTH = 500;

/**
 * Same permissive rule as passport photos -- any raster image type the
 * browser reports, minus SVG (see lib/passport.ts's isAcceptablePhotoType
 * for the reasoning). A photo journal is even more of a "whatever came off
 * my phone" case than a passport scan, so a hardcoded allowlist would
 * silently drop legitimate uploads.
 */
function isAcceptablePhotoType(mimeType: string): boolean {
  return mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

export type PhotoRow = typeof photos.$inferSelect;

function toPublicShape(
  row: PhotoRow,
  uploader: { name: string | null; email: string },
): Photo {
  return {
    id: row.id,
    tripId: row.tripId,
    scope: row.scope,
    dayId: row.dayId,
    itemId: row.itemId,
    uploadedBy: row.uploadedBy,
    uploaderName: uploader.name,
    uploaderEmail: uploader.email,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    caption: row.caption,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  };
}

/** Every photo on the trip, newest first. `capturedAt` when present, else `createdAt`. */
export async function listTripPhotos(access: TripAccess): Promise<Photo[]> {
  const rows = await db
    .select({
      photo: photos,
      uploaderName: users.name,
      uploaderEmail: users.email,
    })
    .from(photos)
    .innerJoin(users, eq(users.id, photos.uploadedBy))
    .where(eq(photos.tripId, access.trip.id))
    .orderBy(desc(sql`coalesce(${photos.capturedAt}, ${photos.createdAt})`));

  return rows.map((row) =>
    toPublicShape(row.photo, { name: row.uploaderName, email: row.uploaderEmail }),
  );
}

/**
 * Photos scoped exactly to `scope="trip"` -- neither a day nor an item.
 * What the trip page's "Trip photos" tab shows, distinct from
 * listTripPhotos above (which is every photo on the trip regardless of
 * where it's pinned).
 */
export async function listTripLevelPhotos(access: TripAccess): Promise<Photo[]> {
  const rows = await db
    .select({
      photo: photos,
      uploaderName: users.name,
      uploaderEmail: users.email,
    })
    .from(photos)
    .innerJoin(users, eq(users.id, photos.uploadedBy))
    .where(and(eq(photos.tripId, access.trip.id), eq(photos.scope, "trip")))
    .orderBy(desc(sql`coalesce(${photos.capturedAt}, ${photos.createdAt})`));

  return rows.map((row) =>
    toPublicShape(row.photo, { name: row.uploaderName, email: row.uploaderEmail }),
  );
}

/**
 * Photos scoped to one specific day -- either pinned directly to the day,
 * or pinned to any item that landed on the day. Chronological (ascending)
 * by capture time, so a day card reads left-to-right through the day.
 */
export async function listDayPhotos(access: TripAccess, dayId: string): Promise<Photo[]> {
  await getDay(access, dayId); // throws if the day isn't part of this trip

  const rows = await db
    .select({
      photo: photos,
      uploaderName: users.name,
      uploaderEmail: users.email,
    })
    .from(photos)
    .innerJoin(users, eq(users.id, photos.uploadedBy))
    .leftJoin(items, eq(items.id, photos.itemId))
    .where(
      and(
        eq(photos.tripId, access.trip.id),
        sql`(${photos.dayId} = ${dayId} or ${items.dayId} = ${dayId})`,
      ),
    )
    .orderBy(asc(sql`coalesce(${photos.capturedAt}, ${photos.createdAt})`));

  return rows.map((row) =>
    toPublicShape(row.photo, { name: row.uploaderName, email: row.uploaderEmail }),
  );
}

/** Photos pinned to one specific item, oldest first. */
export async function listItemPhotos(access: TripAccess, itemId: string): Promise<Photo[]> {
  await getItem(access, itemId); // throws if the item isn't visible to the viewer

  const rows = await db
    .select({
      photo: photos,
      uploaderName: users.name,
      uploaderEmail: users.email,
    })
    .from(photos)
    .innerJoin(users, eq(users.id, photos.uploadedBy))
    .where(and(eq(photos.tripId, access.trip.id), eq(photos.itemId, itemId)))
    .orderBy(asc(sql`coalesce(${photos.capturedAt}, ${photos.createdAt})`));

  return rows.map((row) =>
    toPublicShape(row.photo, { name: row.uploaderName, email: row.uploaderEmail }),
  );
}

export type UploadPhotoInput = {
  scope: PhotoScope;
  /** Required when scope === "day". */
  dayId?: string | null;
  /** Required when scope === "item". */
  itemId?: string | null;
  mimeType: string;
  bytes: Uint8Array;
  caption?: string | null;
  /** Optional EXIF-derived capture time (client-extracted). */
  capturedAt?: Date | null;
};

/**
 * Uploads bytes to R2 and inserts the metadata row. Refuses loudly when
 * storage isn't configured -- there's no acceptable degraded mode where
 * we silently drop uploads on the floor (mirroring passport.ts's
 * requireConfigured posture).
 *
 * The R2 write happens before the DB insert. If the DB insert then fails
 * we do a best-effort delete of the just-uploaded object; a stale object
 * that outlives its DB row is a wasted-bytes leak, not a correctness
 * problem (no row means no way for the app to hand it back out), so a
 * failed cleanup is logged rather than raised to the caller.
 */
export async function uploadPhoto(
  access: TripAccess,
  input: UploadPhotoInput,
): Promise<Photo> {
  if (!isStorageConfigured()) {
    // Same "loud refusal" posture as updatePassportPhoto -- see lib/passport.ts.
    throw new RuleError(
      "Photo storage isn't configured yet — ask whoever runs this app to set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET before uploading anything.",
    );
  }
  if (input.bytes.length === 0) throw new RuleError("That file looks empty.");
  if (input.bytes.length > MAX_PHOTO_BYTES) {
    throw new RuleError(
      `That photo is too large -- ${(MAX_PHOTO_BYTES / (1024 * 1024)).toFixed(0)} MB max.`,
    );
  }
  if (!isAcceptablePhotoType(input.mimeType)) {
    throw new RuleError(
      `That doesn't look like a photo (got "${input.mimeType || "an unrecognized file type"}").`,
    );
  }

  const caption = input.caption?.trim() || null;
  if (caption && caption.length > MAX_CAPTION_LENGTH) {
    throw new RuleError(`Keep the caption under ${MAX_CAPTION_LENGTH} characters.`);
  }

  // Normalize + validate scope-specific FKs before touching storage.
  let dayId: string | null = null;
  let itemId: string | null = null;
  if (input.scope === "day") {
    if (!input.dayId) throw new RuleError("Pick which day the photo is for.");
    await getDay(access, input.dayId);
    dayId = input.dayId;
  } else if (input.scope === "item") {
    if (!input.itemId) throw new RuleError("Pick which item the photo is for.");
    const item = await getItem(access, input.itemId);
    itemId = item.id;
    dayId = item.dayId; // convenience -- lets listDayPhotos join through cleanly
  }

  // Generate the id up-front so the object key we write to R2 matches the
  // row we're about to insert. If the insert fails, we know exactly which
  // key to clean up.
  const id = crypto.randomUUID();
  const storageKey = objectKeyFor(access.trip.id, id);

  await putObject(storageKey, input.bytes, input.mimeType);

  let inserted;
  try {
    [inserted] = await db
      .insert(photos)
      .values({
        id,
        tripId: access.trip.id,
        scope: input.scope,
        dayId,
        itemId,
        uploadedBy: access.viewer.id,
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.length,
        caption,
        capturedAt: input.capturedAt ?? null,
      })
      .returning();
  } catch (err) {
    // Best-effort cleanup; don't mask the original error.
    deleteObject(storageKey).catch((cleanupErr) => {
      console.warn("[photos] failed to clean up orphan R2 object", storageKey, cleanupErr);
    });
    throw err;
  }

  return toPublicShape(inserted, {
    name: access.viewer.name,
    email: access.viewer.email,
  });
}

/** Uploader or a planner -- same rule as deleteComment. */
export async function deletePhoto(access: TripAccess, photoId: string): Promise<void> {
  const [row] = await db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
  if (!row) throw new RuleError("That photo is already gone.");
  if (row.tripId !== access.trip.id) throw new RuleError("That photo isn't on this trip.");
  if (row.uploadedBy !== access.viewer.id && !access.isPlanner) {
    throw new RuleError("Only the uploader, or a planner, can delete a photo.");
  }

  await db.delete(photos).where(eq(photos.id, photoId));
  // Best-effort object delete. A DB row is the authority; a stale R2
  // object costs bytes, not correctness.
  deleteObject(row.storageKey).catch((err) => {
    console.warn("[photos] failed to remove R2 object for deleted photo", row.storageKey, err);
  });
}

/**
 * Updates the caption on a photo. Same edit rule as deletePhoto -- the
 * uploader or a planner. Passing an empty/whitespace-only caption clears
 * it back to null.
 */
export async function updatePhotoCaption(
  access: TripAccess,
  photoId: string,
  caption: string | null,
): Promise<Photo> {
  const [row] = await db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
  if (!row) throw new RuleError("That photo is already gone.");
  if (row.tripId !== access.trip.id) throw new RuleError("That photo isn't on this trip.");
  if (row.uploadedBy !== access.viewer.id && !access.isPlanner) {
    throw new RuleError("Only the uploader, or a planner, can edit a caption.");
  }

  const trimmed = caption?.trim() || null;
  if (trimmed && trimmed.length > MAX_CAPTION_LENGTH) {
    throw new RuleError(`Keep the caption under ${MAX_CAPTION_LENGTH} characters.`);
  }

  const [updated] = await db
    .update(photos)
    .set({ caption: trimmed })
    .where(eq(photos.id, photoId))
    .returning();

  // Uploader identity doesn't change; re-look it up so the returned shape
  // is complete even when the editor isn't the uploader.
  const [uploader] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, updated.uploadedBy))
    .limit(1);

  return toPublicShape(updated, uploader ?? { name: null, email: "" });
}

/**
 * A short-lived URL an `<img>` can fetch. Trip-scoped check first, so a
 * guessed photo id from another trip returns a 404 rather than a
 * cross-trip leak.
 */
export async function viewablePhotoUrl(
  access: TripAccess,
  photoId: string,
): Promise<{ url: string; mimeType: string } | null> {
  const [row] = await db
    .select({ storageKey: photos.storageKey, mimeType: photos.mimeType, tripId: photos.tripId })
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);
  if (!row || row.tripId !== access.trip.id) return null;
  const url = await signedGetUrl(row.storageKey);
  return { url, mimeType: row.mimeType };
}

/**
 * A batched R2 sweep: given a trip that's about to be deleted (or a set of
 * ids the app has already dropped from the DB), clean up their objects.
 * The DB is the authority on whether a photo exists -- see deletePhoto's
 * comment on why -- so this is a periodic-cleanup style call, not part of
 * the trip-delete happy path.
 */
export async function purgeStorageForTrip(tripId: string): Promise<void> {
  const rows = await db
    .select({ storageKey: photos.storageKey })
    .from(photos)
    .where(eq(photos.tripId, tripId));
  await deleteObjects(rows.map((r) => r.storageKey));
}

/**
 * If an item or day was deleted while a photo pointed at it, the FK's
 * `set null` left the photo dangling with a stale scope. This walks the
 * trip's rows and moves any such photo back to `scope="trip"` so it
 * reappears in the trip gallery rather than getting hidden by day/item
 * filters. Cheap enough to call opportunistically; guarded by
 * `access.isPlanner` at every call site.
 */
export async function detachOrphanedPhotos(access: TripAccess): Promise<number> {
  const stale = await db
    .select({ id: photos.id })
    .from(photos)
    .where(
      and(
        eq(photos.tripId, access.trip.id),
        sql`(
          (${photos.scope} = 'day' and ${photos.dayId} is null)
          or (${photos.scope} = 'item' and ${photos.itemId} is null)
        )`,
      ),
    );
  if (stale.length === 0) return 0;

  await db
    .update(photos)
    .set({ scope: "trip", dayId: null, itemId: null })
    .where(inArray(photos.id, stale.map((r) => r.id)));
  return stale.length;
}

