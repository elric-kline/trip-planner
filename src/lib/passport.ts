import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { passportDetails } from "@/db/schema";
import { encryptText, decryptText, encryptBytes, decryptBytes, isEncryptionConfigured } from "./encryption.ts";
import type { CurrentUser } from "./auth.ts";
import type { TripAccess } from "./scope.ts";

export class RuleError extends Error {}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB -- generous for a passport photo page scan, cheap enough to store as encrypted text (see schema.ts)
const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

export type PassportInput = {
  fullName?: string | null;
  passportNumber?: string | null;
  nationality?: string | null;
  /** YYYY-MM-DD */
  dateOfBirth?: string | null;
  /** YYYY-MM-DD */
  expiryDate?: string | null;
};

/** Decrypted, ready to show someone who's already been cleared to see it -- see canViewMemberPassport. Deliberately doesn't include the photo bytes (see getPassportPhoto) -- a text-fields read shouldn't have to decrypt a multi-MB image nobody asked to see yet. */
export type PassportDetails = {
  fullName: string | null;
  passportNumber: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  expiryDate: string | null;
  hasPhoto: boolean;
  updatedAt: Date;
};

function decryptOrNull(value: string | null): string | null {
  return value ? decryptText(value) : null;
}

/**
 * Null if this user has never saved anything here -- same "null until set"
 * posture as getLodgingDetails. The caller is responsible for having
 * already established that the viewer may see this -- same convention as
 * getLodgingDetails(itemId) trusting the item detail page to have checked
 * access first; here that's canViewMemberPassport (below) or "it's my own,"
 * checked by whichever route/page calls this.
 */
export async function getPassportDetails(userId: string): Promise<PassportDetails | null> {
  const [row] = await db.select().from(passportDetails).where(eq(passportDetails.userId, userId)).limit(1);
  if (!row) return null;
  return {
    fullName: decryptOrNull(row.fullNameEncrypted),
    passportNumber: decryptOrNull(row.passportNumberEncrypted),
    nationality: decryptOrNull(row.nationalityEncrypted),
    dateOfBirth: decryptOrNull(row.dateOfBirthEncrypted),
    expiryDate: decryptOrNull(row.expiryDateEncrypted),
    hasPhoto: row.photoEncrypted != null,
    updatedAt: row.updatedAt,
  };
}

/**
 * Batched: every one of these users' passport text fields (never the
 * photo -- see the module doc comment above getPassportPhoto for why
 * that's kept separate even here), keyed by userId, only for those who've
 * actually saved something. Built for a trip's People list, where a
 * planner may be looking at several members at once -- one query and one
 * decrypt pass per field per person, not one round trip per member. Same
 * "caller already checked access" contract as getPassportDetails; a
 * caller here is expected to have already filtered `userIds` down to
 * whoever canViewMemberPassport actually allows.
 */
export async function getPassportDetailsForUsers(userIds: string[]): Promise<Map<string, PassportDetails>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.select().from(passportDetails).where(inArray(passportDetails.userId, userIds));
  return new Map(
    rows.map((row) => [
      row.userId,
      {
        fullName: decryptOrNull(row.fullNameEncrypted),
        passportNumber: decryptOrNull(row.passportNumberEncrypted),
        nationality: decryptOrNull(row.nationalityEncrypted),
        dateOfBirth: decryptOrNull(row.dateOfBirthEncrypted),
        expiryDate: decryptOrNull(row.expiryDateEncrypted),
        hasPhoto: row.photoEncrypted != null,
        updatedAt: row.updatedAt,
      },
    ]),
  );
}

/** The photo alone, decrypted -- kept separate from getPassportDetails so a page that just wants to know whether one exists (hasPhoto) never pays to decrypt the image itself. Null if none was ever uploaded. */
export async function getPassportPhoto(userId: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const [row] = await db
    .select({ photoEncrypted: passportDetails.photoEncrypted, photoMimeType: passportDetails.photoMimeType })
    .from(passportDetails)
    .where(eq(passportDetails.userId, userId))
    .limit(1);
  if (!row?.photoEncrypted || !row.photoMimeType) return null;
  return { bytes: decryptBytes(row.photoEncrypted), mimeType: row.photoMimeType };
}

/**
 * `data:<mime>;base64,...`, ready to drop straight into an `<img src>` --
 * used for the profile page's own preview of your own single photo, where
 * inlining it costs nothing extra (you're already looking at the page
 * that's showing it to you). A fellow member's photo instead goes through
 * the lazy, authenticated /api/trip/[tripId]/members/[userId]/passport-photo
 * route -- a People list can show several members at once, and inlining
 * every one of their photos on every load isn't a cost worth paying by
 * default when a "view photo" link only needs to pay it on click. Null if
 * there's no photo.
 */
export async function getPassportPhotoDataUri(userId: string): Promise<string | null> {
  const photo = await getPassportPhoto(userId);
  if (!photo) return null;
  return `data:${photo.mimeType};base64,${photo.bytes.toString("base64")}`;
}

function requireConfigured(): void {
  if (!isEncryptionConfigured()) {
    throw new RuleError(
      "Passport storage isn't configured yet — ask whoever runs this app to set PASSPORT_ENCRYPTION_KEY before saving anything sensitive here.",
    );
  }
}

function assertValidDate(label: string, value: string | null | undefined): void {
  if (value == null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RuleError(`${label} must be a valid date.`);
  }
}

/**
 * A user only ever edits their own passport info -- no "edit someone
 * else's" path, same as updateProfile. Refuses outright (rather than
 * silently storing plaintext) when PASSPORT_ENCRYPTION_KEY isn't
 * configured -- this is the one place in the app where "just don't
 * encrypt it" is never an acceptable degraded mode.
 */
export async function updatePassportDetails(viewer: CurrentUser, input: PassportInput): Promise<void> {
  requireConfigured();
  assertValidDate("Date of birth", input.dateOfBirth);
  assertValidDate("Expiry date", input.expiryDate);

  const encryptOrNull = (value: string | null | undefined) => (value ? encryptText(value) : undefined);

  await db
    .insert(passportDetails)
    .values({
      userId: viewer.id,
      fullNameEncrypted: encryptOrNull(input.fullName),
      passportNumberEncrypted: encryptOrNull(input.passportNumber),
      nationalityEncrypted: encryptOrNull(input.nationality),
      dateOfBirthEncrypted: encryptOrNull(input.dateOfBirth),
      expiryDateEncrypted: encryptOrNull(input.expiryDate),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: passportDetails.userId,
      set: {
        ...(input.fullName !== undefined ? { fullNameEncrypted: encryptOrNull(input.fullName) ?? null } : {}),
        ...(input.passportNumber !== undefined ? { passportNumberEncrypted: encryptOrNull(input.passportNumber) ?? null } : {}),
        ...(input.nationality !== undefined ? { nationalityEncrypted: encryptOrNull(input.nationality) ?? null } : {}),
        ...(input.dateOfBirth !== undefined ? { dateOfBirthEncrypted: encryptOrNull(input.dateOfBirth) ?? null } : {}),
        ...(input.expiryDate !== undefined ? { expiryDateEncrypted: encryptOrNull(input.expiryDate) ?? null } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Replaces any existing photo -- one photo per person, same as one address per lodging item. */
export async function updatePassportPhoto(viewer: CurrentUser, bytes: Buffer, mimeType: string): Promise<void> {
  requireConfigured();
  if (bytes.length === 0) throw new RuleError("That file looks empty.");
  if (bytes.length > MAX_PHOTO_BYTES) throw new RuleError("That photo is too large -- 8 MB max.");
  if (!ALLOWED_PHOTO_TYPES.has(mimeType)) {
    throw new RuleError("Photos must be JPEG, PNG, WebP, or HEIC.");
  }

  await db
    .insert(passportDetails)
    .values({ userId: viewer.id, photoEncrypted: encryptBytes(bytes), photoMimeType: mimeType, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: passportDetails.userId,
      set: { photoEncrypted: encryptBytes(bytes), photoMimeType: mimeType, updatedAt: new Date() },
    });
}

export async function removePassportPhoto(viewer: CurrentUser): Promise<void> {
  await db
    .update(passportDetails)
    .set({ photoEncrypted: null, photoMimeType: null, updatedAt: new Date() })
    .where(eq(passportDetails.userId, viewer.id));
}

/** Clears every field, including the photo -- the whole row is left in place (rather than deleted) so updatedAt/onConflictDoUpdate keep working the same way on the next save; an all-null row and "no row" already read identically to every caller here (see getPassportDetails/getPassportPhoto's own null checks). */
export async function removePassportDetails(viewer: CurrentUser): Promise<void> {
  await db
    .update(passportDetails)
    .set({
      fullNameEncrypted: null,
      passportNumberEncrypted: null,
      nationalityEncrypted: null,
      dateOfBirthEncrypted: null,
      expiryDateEncrypted: null,
      photoEncrypted: null,
      photoMimeType: null,
      updatedAt: new Date(),
    })
    .where(eq(passportDetails.userId, viewer.id));
}

/**
 * Deliberately narrower than dietary info's "any co-member on a shared
 * trip" (see schema.ts's passportDetails doc comment): only this trip's
 * planner may see a fellow member's passport info, matching "the person
 * making bookings needs everyone's passport info" -- not every
 * participant needs to browse each other's passport numbers. Trip-scoped
 * rather than "shares any trip with a planner somewhere" on purpose: a
 * passport reveal is always reached from one specific trip's People list,
 * so there's no need for a cross-trip lookup -- `access` (already loaded
 * for that trip) is everything this needs to know.
 */
export function canViewMemberPassport(access: TripAccess, targetUserId: string): boolean {
  if (targetUserId === access.viewer.id) return true;
  return access.isPlanner && access.members.some((m) => m.userId === targetUserId);
}
