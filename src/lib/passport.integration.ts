import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { passportDetails, users } from "@/db/schema";
import {
  getPassportDetails,
  getPassportDetailsForUsers,
  getPassportPhoto,
  getPassportPhotoDataUri,
  updatePassportDetails,
  updatePassportPhoto,
  removePassportPhoto,
  removePassportDetails,
  canViewMemberPassport,
  RuleError,
} from "./passport.ts";
import { requireTripAccess } from "./scope.ts";
import { setMemberRole } from "./trips.ts";
import { createTestTrip, createTestUser, addTripMember, cleanupTrip } from "./test-fixtures.ts";

const TEST_KEY = Buffer.alloc(32, 9).toString("base64");

function withEncryption(t: { after: (fn: () => void) => void }) {
  process.env.PASSPORT_ENCRYPTION_KEY = TEST_KEY;
  t.after(() => {
    delete process.env.PASSPORT_ENCRYPTION_KEY;
  });
}

/** These tests mostly need a lone user, no trip -- cleanupTrip (test-fixtures.ts) always wants a trip id, so this is the direct equivalent for a user with no trip involved; passport_details cascades on user delete (see schema.ts), so nothing else to clean up. */
async function deleteTestUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

test("getPassportDetails is null until something is saved; updatePassportDetails then creates or replaces, round-tripping through real encryption", async (t) => {
  withEncryption(t);
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  assert.equal(await getPassportDetails(user.id), null);

  await updatePassportDetails(user, { fullName: "Jane Q. Traveler", passportNumber: "P1234567" });
  const first = await getPassportDetails(user.id);
  assert.equal(first?.fullName, "Jane Q. Traveler");
  assert.equal(first?.passportNumber, "P1234567");
  assert.equal(first?.hasPhoto, false);

  await updatePassportDetails(user, { nationality: "New Zealand" });
  const second = await getPassportDetails(user.id);
  assert.equal(second?.nationality, "New Zealand");
  assert.equal(second?.fullName, "Jane Q. Traveler", "a field omitted from this call's input is left as-is");

  // The actual database row never holds the plaintext -- this is the whole point.
  const [row] = await db.select().from(passportDetails).where(eq(passportDetails.userId, user.id)).limit(1);
  assert.ok(row?.fullNameEncrypted);
  assert.doesNotMatch(row.fullNameEncrypted, /Jane/);
  assert.ok(row?.passportNumberEncrypted);
  assert.doesNotMatch(row.passportNumberEncrypted, /P1234567/);
});

test("updatePassportDetails refuses to save anything when PASSPORT_ENCRYPTION_KEY isn't configured, rather than storing plaintext", async (t) => {
  delete process.env.PASSPORT_ENCRYPTION_KEY;
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  await assert.rejects(() => updatePassportDetails(user, { fullName: "Jane" }), RuleError);
  assert.equal(await getPassportDetails(user.id), null);
});

test("updatePassportDetails rejects a malformed date", async (t) => {
  withEncryption(t);
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  await assert.rejects(() => updatePassportDetails(user, { expiryDate: "not-a-date" }), RuleError);
  await assert.rejects(() => updatePassportDetails(user, { dateOfBirth: "13/45/2020" }), RuleError);
});

test("updatePassportPhoto/getPassportPhoto/getPassportPhotoDataUri round-trip a real photo through encryption; removePassportPhoto clears it without touching the text fields", async (t) => {
  withEncryption(t);
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  await updatePassportDetails(user, { fullName: "Jane Q. Traveler" });
  assert.equal(await getPassportPhoto(user.id), null);
  assert.equal((await getPassportDetails(user.id))?.hasPhoto, false);

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
  await updatePassportPhoto(user, jpegBytes, "image/jpeg");

  const photo = await getPassportPhoto(user.id);
  assert.deepEqual(photo?.bytes, jpegBytes);
  assert.equal(photo?.mimeType, "image/jpeg");
  assert.equal((await getPassportDetails(user.id))?.hasPhoto, true);

  const dataUri = await getPassportPhotoDataUri(user.id);
  assert.equal(dataUri, `data:image/jpeg;base64,${jpegBytes.toString("base64")}`);

  await removePassportPhoto(user);
  assert.equal(await getPassportPhoto(user.id), null);
  assert.equal((await getPassportDetails(user.id))?.fullName, "Jane Q. Traveler", "removing the photo doesn't touch the text fields");
});

test("updatePassportPhoto rejects an oversized file, a non-image content type, and an SVG specifically", async (t) => {
  withEncryption(t);
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  await assert.rejects(() => updatePassportPhoto(user, Buffer.alloc(9 * 1024 * 1024), "image/jpeg"), RuleError);
  await assert.rejects(() => updatePassportPhoto(user, Buffer.from([1, 2, 3]), "application/pdf"), RuleError);
  await assert.rejects(() => updatePassportPhoto(user, Buffer.from([1, 2, 3]), "image/svg+xml"), RuleError);
  await assert.rejects(() => updatePassportPhoto(user, Buffer.alloc(0), "image/jpeg"), RuleError);
});

test("updatePassportPhoto accepts any real image content type, not just a fixed shortlist -- phone camera uploads report a lot of variety here", async (t) => {
  withEncryption(t);
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  // iOS alone reports HEIC photos as either of these depending on version;
  // image/tiff and image/bmp cover less common but still legitimate
  // photo-library exports. None of these were in the old fixed Set.
  for (const mimeType of ["image/heic", "image/heif", "image/tiff", "image/bmp", "image/gif"]) {
    await updatePassportPhoto(user, Buffer.from([1, 2, 3]), mimeType);
    const photo = await getPassportPhoto(user.id);
    assert.equal(photo?.mimeType, mimeType, `${mimeType} should be accepted`);
  }
});

test("removePassportDetails clears every field, including the photo", async (t) => {
  withEncryption(t);
  const user = await createTestUser();
  t.after(() => deleteTestUser(user.id));

  await updatePassportDetails(user, { fullName: "Jane", passportNumber: "P1", nationality: "NZ", dateOfBirth: "1990-01-01", expiryDate: "2030-01-01" });
  await updatePassportPhoto(user, Buffer.from([1, 2, 3]), "image/png");

  await removePassportDetails(user);

  const details = await getPassportDetails(user.id);
  assert.deepEqual(details, {
    fullName: null,
    passportNumber: null,
    nationality: null,
    dateOfBirth: null,
    expiryDate: null,
    hasPhoto: false,
    updatedAt: details?.updatedAt,
  });
  assert.equal(await getPassportPhoto(user.id), null);
});

test("getPassportDetailsForUsers batches multiple members in one query, keyed by userId, skipping anyone who's never saved anything", async (t) => {
  withEncryption(t);
  const withPassport = await createTestUser();
  const withoutPassport = await createTestUser();
  t.after(() => Promise.all([deleteTestUser(withPassport.id), deleteTestUser(withoutPassport.id)]));

  await updatePassportDetails(withPassport, { fullName: "Jane", passportNumber: "P1" });

  const map = await getPassportDetailsForUsers([withPassport.id, withoutPassport.id]);
  assert.equal(map.size, 1);
  assert.equal(map.get(withPassport.id)?.fullName, "Jane");
  assert.equal(map.has(withoutPassport.id), false);

  assert.deepEqual(await getPassportDetailsForUsers([]), new Map());
});

test("canViewMemberPassport: always true for your own; true for a fellow trip member only when the viewer is that trip's planner; false for a non-planner participant, and false for someone on a different trip entirely", async (t) => {
  const planner = await createTestUser();
  const participant = await createTestUser();
  const outsider = await createTestUser(); // never joins the trip at all
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, participant.id, "participant");
  t.after(() => cleanupTrip(trip.id, [planner.id, participant.id, outsider.id]));

  const plannerAccess = await requireTripAccess(trip.id, planner);
  const participantAccess = await requireTripAccess(trip.id, participant);

  assert.equal(canViewMemberPassport(plannerAccess, planner.id), true, "always your own");
  assert.equal(canViewMemberPassport(participantAccess, participant.id), true, "always your own");

  assert.equal(canViewMemberPassport(plannerAccess, participant.id), true, "planner viewing a fellow member");
  assert.equal(canViewMemberPassport(participantAccess, planner.id), false, "a participant is not a planner");

  assert.equal(canViewMemberPassport(plannerAccess, outsider.id), false, "not even a planner can see a non-member's passport");
});

test("canViewMemberPassport: an appointed co-planner gets the same passport visibility as the master planner", async (t) => {
  const owner = await createTestUser();
  const coPlanner = await createTestUser();
  const otherMember = await createTestUser();
  const trip = await createTestTrip(owner);
  await addTripMember(trip.id, coPlanner.id, "participant");
  await addTripMember(trip.id, otherMember.id, "participant");
  t.after(() => cleanupTrip(trip.id, [owner.id, coPlanner.id, otherMember.id]));

  const beforeAccess = await requireTripAccess(trip.id, coPlanner);
  assert.equal(canViewMemberPassport(beforeAccess, otherMember.id), false, "a plain participant can't see a fellow member's passport");

  await setMemberRole(await requireTripAccess(trip.id, owner), coPlanner.id, "co_planner");

  const afterAccess = await requireTripAccess(trip.id, coPlanner);
  assert.equal(canViewMemberPassport(afterAccess, otherMember.id), true, "appointing them a co-planner grants the same visibility as the master");
});
