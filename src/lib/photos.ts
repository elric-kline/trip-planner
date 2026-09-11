import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { items, photos, users } from "@/db/schema";
import { getItem, type TripAccess } from "./scope.ts";
import { getDay } from "./days.ts";
import { RuleError } from "./items.ts";
import {
  deleteObject,
  deleteObjects,
  getObject,
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
 * Common raster mime → filename extension. Not exhaustive by design:
 * anything the browser reports and we don't have a mapping for gets `.bin`,
 * which is honest ("we don't know what this is") rather than pretending it's
 * a jpg. Used only for the download filename hint -- the file's real bytes
 * are unchanged either way.
 */
function extensionFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/heic") return "heic";
  if (m === "image/heif") return "heif";
  if (m === "image/gif") return "gif";
  if (m === "image/avif") return "avif";
  if (m === "image/bmp") return "bmp";
  if (m === "image/tiff") return "tiff";
  return "bin";
}

/**
 * Builds a filename that reads well in Finder / Files / the download tray:
 * `photo-YYYYMMDD-HHmm.<ext>`. Uses `capturedAt` when the uploader supplied
 * it (EXIF), falling back to `createdAt`. Deliberately no trip name or
 * caption in the filename -- both can carry punctuation the filesystem or
 * a share-sheet target dislikes.
 */
function filenameFor(mimeType: string, at: Date): string {
  const iso = at.toISOString(); // "2026-04-20T15:30:00.000Z"
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return `photo-${stamp}.${extensionFor(mimeType)}`;
}

/**
 * The bytes plus the metadata a download response needs (mime, filename).
 * Trip-scoped check same as viewablePhotoUrl -- a photo id from another
 * trip returns null. Buffers the object in memory: photos are already
 * capped at 15 MB (see uploadPhoto), which is fine for a per-request
 * proxy.
 *
 * Why proxy through the server instead of redirecting to an R2 URL with a
 * Content-Disposition override: presigned URLs support the override,
 * custom-domain public URLs don't. Proxying uniformly is what lets the
 * download button behave the same either way.
 */
export async function downloadablePhoto(
  access: TripAccess,
  photoId: string,
): Promise<{ bytes: Uint8Array; mimeType: string; filename: string } | null> {
  const [row] = await db
    .select({
      storageKey: photos.storageKey,
      mimeType: photos.mimeType,
      tripId: photos.tripId,
      capturedAt: photos.capturedAt,
      createdAt: photos.createdAt,
    })
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);
  if (!row || row.tripId !== access.trip.id) return null;

  const { bytes } = await getObject(row.storageKey);
  return {
    bytes,
    mimeType: row.mimeType,
    filename: filenameFor(row.mimeType, row.capturedAt ?? row.createdAt),
  };
}

/**
 * The metadata a bulk-download route needs to stream a zip. Same trip-scope
 * check as downloadablePhoto -- any id that isn't on this trip is silently
 * dropped rather than refused, so a single stale id doesn't blow up the
 * whole batch. Deliberately does NOT read bytes here: the zip writer wants
 * them one at a time as it streams, and holding the whole batch in memory
 * would defeat the streaming zip's own reason for existing.
 *
 * Ordered by capture time (then creation), matching listTripPhotos so a zip
 * feels like the same journal the viewer just filtered. Duplicate ids in
 * the input are deduped -- a viewer can't accidentally re-add the same
 * photo four times by rapid tapping.
 */
export type BatchEntry = {
  id: string;
  storageKey: string;
  mimeType: string;
  filename: string;
};

/** Hard cap on batch size -- big enough for any realistic "give me my day's photos" and small enough to bound the R2 read cost. */
export const MAX_BATCH_PHOTOS = 200;

export async function downloadableBatch(
  access: TripAccess,
  photoIds: string[],
): Promise<BatchEntry[]> {
  if (photoIds.length === 0) return [];
  if (photoIds.length > MAX_BATCH_PHOTOS) {
    throw new RuleError(`That's a lot -- pick at most ${MAX_BATCH_PHOTOS} photos at a time.`);
  }

  const uniqueIds = [...new Set(photoIds)];
  const rows = await db
    .select({
      id: photos.id,
      tripId: photos.tripId,
      storageKey: photos.storageKey,
      mimeType: photos.mimeType,
      capturedAt: photos.capturedAt,
      createdAt: photos.createdAt,
    })
    .from(photos)
    .where(and(eq(photos.tripId, access.trip.id), inArray(photos.id, uniqueIds)));

  // A collision-avoidance suffix: two photos taken in the same minute would
  // otherwise get the same filenameFor() output and clobber each other in
  // the zip. Adding the row id's first eight characters is enough.
  const usedNames = new Set<string>();
  const disambiguate = (name: string, id: string): string => {
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot === -1 ? name : name.slice(0, dot);
    const ext = dot === -1 ? "" : name.slice(dot);
    const suffixed = `${stem}-${id.slice(0, 8)}${ext}`;
    usedNames.add(suffixed);
    return suffixed;
  };

  const sorted = rows
    .slice()
    .sort((a, b) => {
      const at = (a.capturedAt ?? a.createdAt).getTime();
      const bt = (b.capturedAt ?? b.createdAt).getTime();
      return at - bt;
    });

  return sorted.map((row) => ({
    id: row.id,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    filename: disambiguate(
      filenameFor(row.mimeType, row.capturedAt ?? row.createdAt),
      row.id,
    ),
  }));
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

