import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deletePhoto,
  downloadableBatch,
  downloadablePhoto,
  listDayPhotos,
  listItemPhotos,
  listTripLevelPhotos,
  listTripPhotos,
  MAX_BATCH_PHOTOS,
  updatePhotoCaption,
  uploadPhoto,
} from "./photos.ts";
import { createItem, deleteItem } from "./items.ts";
import { requireTripAccess } from "./scope.ts";
import { installTestBackend, resetBackend, type StorageBackend } from "./r2.ts";
import { RuleError } from "./items.ts";
import { addTripMember, cleanupTrip, createTestTrip, createTestUser } from "./test-fixtures.ts";
import { listDays } from "./days.ts";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * lib/photos.ts against a real Postgres, with R2 swapped for an in-memory
 * bucket. The point of these tests is the scope enforcement (uploader vs.
 * planner delete, cross-trip isolation, day/item validation) and the
 * DB-side side effects of a delete -- the R2 side of the pipeline is
 * covered by lib/r2.test.ts and by the stub below returning what real R2
 * would.
 */

type BucketOp = { op: "put" | "get" | "delete" | "url"; key: string };

function memoryBackend(): {
  backend: StorageBackend;
  store: Map<string, { bytes: Uint8Array; mimeType: string }>;
  ops: BucketOp[];
} {
  const store = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const ops: BucketOp[] = [];
  return {
    store,
    ops,
    backend: {
      async putObject(key, bytes, mimeType) {
        ops.push({ op: "put", key });
        store.set(key, { bytes, mimeType });
      },
      async getObject(key) {
        ops.push({ op: "get", key });
        const entry = store.get(key);
        if (!entry) throw new Error(`memoryBackend: no object at ${key}`);
        return entry;
      },
      async deleteObject(key) {
        ops.push({ op: "delete", key });
        store.delete(key);
      },
      async deleteObjects(keys) {
        for (const key of keys) {
          ops.push({ op: "delete", key });
          store.delete(key);
        }
      },
      async signedGetUrl(key) {
        ops.push({ op: "url", key });
        return `memory://${key}`;
      },
    },
  };
}

/** A minimal 1x1 PNG -- just enough bytes to prove the storage contract. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

async function setup() {
  const planner = await createTestUser();
  const member = await createTestUser();
  const outsider = await createTestUser();
  const trip = await createTestTrip(planner);
  await addTripMember(trip.id, member.id, "participant");
  const otherTrip = await createTestTrip(outsider);

  const plannerAccess = await requireTripAccess(trip.id, planner);
  const memberAccess = await requireTripAccess(trip.id, member);
  const outsiderAccess = await requireTripAccess(otherTrip.id, outsider);

  const days = await listDays(plannerAccess);
  return {
    trip,
    otherTrip,
    userIds: [planner.id, member.id, outsider.id],
    planner,
    member,
    plannerAccess,
    memberAccess,
    outsiderAccess,
    days,
  };
}

test("an unconfigured deploy refuses uploads with a legible message", async (t) => {
  const ctx = await setup();
  t.after(async () => {
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  resetBackend();
  // No R2 env vars in test, and no stub installed -- isStorageConfigured is false.
  await assert.rejects(
    () =>
      uploadPhoto(ctx.plannerAccess, {
        scope: "trip",
        mimeType: "image/png",
        bytes: TINY_PNG,
      }),
    (err) => err instanceof RuleError && /storage isn't configured/i.test((err as Error).message),
  );
});

test("uploads to trip scope round-trip through list and view URL", async (t) => {
  const ctx = await setup();
  const { backend, store } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const uploaded = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
    caption: "  arrival day  ",
  });

  assert.equal(uploaded.scope, "trip");
  assert.equal(uploaded.dayId, null);
  assert.equal(uploaded.itemId, null);
  assert.equal(uploaded.caption, "arrival day");
  assert.equal(uploaded.sizeBytes, TINY_PNG.length);
  assert.equal(store.size, 1, "one object landed in the bucket");

  const trip = await listTripPhotos(ctx.plannerAccess);
  assert.equal(trip.length, 1);
  const asMember = await listTripPhotos(ctx.memberAccess);
  assert.equal(asMember.length, 1, "any member of the trip sees it too");
});

test("scope=day requires a real day of this trip", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  await assert.rejects(
    () =>
      uploadPhoto(ctx.plannerAccess, {
        scope: "day",
        mimeType: "image/png",
        bytes: TINY_PNG,
      }),
    /Pick which day/,
  );

  // A day from another trip is refused too (getDay throws).
  const otherDays = await listDays(ctx.outsiderAccess);
  await assert.rejects(
    () =>
      uploadPhoto(ctx.plannerAccess, {
        scope: "day",
        dayId: otherDays[0].id,
        mimeType: "image/png",
        bytes: TINY_PNG,
      }),
    /isn't part of this trip/,
  );

  const good = await uploadPhoto(ctx.plannerAccess, {
    scope: "day",
    dayId: ctx.days[0].id,
    mimeType: "image/png",
    bytes: TINY_PNG,
  });
  assert.equal(good.scope, "day");
  assert.equal(good.dayId, ctx.days[0].id);
});

test("scope=item hydrates the item's own dayId and appears in day gallery", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const item = await createItem(ctx.plannerAccess, {
    title: "Sunrise hike",
    dayId: ctx.days[1].id,
  });
  const photo = await uploadPhoto(ctx.plannerAccess, {
    scope: "item",
    itemId: item.id,
    mimeType: "image/png",
    bytes: TINY_PNG,
    caption: "top of the ridge",
  });
  assert.equal(photo.scope, "item");
  assert.equal(photo.itemId, item.id);
  assert.equal(photo.dayId, ctx.days[1].id, "day is inferred from the item");

  const dayGallery = await listDayPhotos(ctx.plannerAccess, ctx.days[1].id);
  assert.deepEqual(
    dayGallery.map((p) => p.id),
    [photo.id],
    "an item-scoped photo shows up in its day's mixed gallery",
  );

  const itemGallery = await listItemPhotos(ctx.plannerAccess, item.id);
  assert.equal(itemGallery.length, 1);
});

test("trip-wide list is separate from listTripPhotos (all) and from the day gallery", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  await uploadPhoto(ctx.plannerAccess, { scope: "trip", mimeType: "image/png", bytes: TINY_PNG });
  await uploadPhoto(ctx.plannerAccess, {
    scope: "day",
    dayId: ctx.days[2].id,
    mimeType: "image/png",
    bytes: TINY_PNG,
  });

  assert.equal((await listTripPhotos(ctx.plannerAccess)).length, 2);
  assert.equal((await listTripLevelPhotos(ctx.plannerAccess)).length, 1);
  assert.equal((await listDayPhotos(ctx.plannerAccess, ctx.days[2].id)).length, 1);
});

test("only the uploader or a planner can delete a photo", async (t) => {
  const ctx = await setup();
  const { backend, store } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const byMember = await uploadPhoto(ctx.memberAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
  });
  const byPlanner = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
  });

  // A participant can't delete someone else's photo.
  await assert.rejects(
    () => deletePhoto(ctx.memberAccess, byPlanner.id),
    /Only the uploader, or a planner/,
  );

  // The uploader can delete their own.
  await deletePhoto(ctx.memberAccess, byMember.id);
  // A planner can delete anyone's.
  await deletePhoto(ctx.plannerAccess, byPlanner.id);

  const remaining = await listTripPhotos(ctx.plannerAccess);
  assert.equal(remaining.length, 0);
  assert.equal(store.size, 0, "R2 objects are cleaned up alongside their rows");
});

test("a cross-trip photo id can't be edited or deleted through another trip's access", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const photo = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
  });

  await assert.rejects(
    () => deletePhoto(ctx.outsiderAccess, photo.id),
    /isn't on this trip/,
  );
  await assert.rejects(
    () => updatePhotoCaption(ctx.outsiderAccess, photo.id, "sneaky"),
    /isn't on this trip/,
  );
});

test("deleting the item leaves its photos re-scopable back to the trip", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const item = await createItem(ctx.plannerAccess, {
    title: "Deleted plan",
    dayId: ctx.days[0].id,
  });
  const photo = await uploadPhoto(ctx.plannerAccess, {
    scope: "item",
    itemId: item.id,
    mimeType: "image/png",
    bytes: TINY_PNG,
  });

  await deleteItem(ctx.plannerAccess, item.id);

  // The photo survives (item FK is `set null`).
  const [row] = await db.select().from(photos).where(eq(photos.id, photo.id)).limit(1);
  assert.ok(row, "photo row still there after item deletion");
  assert.equal(row.itemId, null, "orphan itemId is null");
  // scope stays "item" until the app-level detach runs -- that's what
  // detachOrphanedPhotos exists for; here we just care the FK didn't
  // cascade the photo out of existence.
  assert.equal(row.scope, "item");
});

test("caption is trimmed on write, and can be cleared with an empty string", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const photo = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
    caption: "first draft",
  });
  const edited = await updatePhotoCaption(ctx.plannerAccess, photo.id, "  polished  ");
  assert.equal(edited.caption, "polished");
  const cleared = await updatePhotoCaption(ctx.plannerAccess, photo.id, "");
  assert.equal(cleared.caption, null);
});

test("downloadablePhoto returns bytes + a friendly filename, and refuses cross-trip", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const uploaded = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
    capturedAt: new Date("2026-04-20T15:30:00Z"),
  });

  const download = await downloadablePhoto(ctx.plannerAccess, uploaded.id);
  assert.ok(download, "downloadable when scoped correctly");
  assert.deepEqual(Array.from(download!.bytes), Array.from(TINY_PNG), "bytes round-trip through R2");
  assert.equal(download!.mimeType, "image/png");
  // filename shape: photo-YYYYMMDD-HHmm.<ext>
  assert.match(download!.filename, /^photo-20260420-1530\.png$/);

  // Cross-trip guardrail
  const cross = await downloadablePhoto(ctx.outsiderAccess, uploaded.id);
  assert.equal(cross, null, "another trip's viewer sees null, not the bytes");
});

test("downloadableBatch: empty ids returns [], and refuses more than the cap", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  assert.deepEqual(await downloadableBatch(ctx.plannerAccess, []), []);

  await assert.rejects(
    () => downloadableBatch(ctx.plannerAccess, new Array(MAX_BATCH_PHOTOS + 1).fill("x")),
    /at most 200/,
  );
});

test("downloadableBatch drops ids from other trips, dedupes, and orders by capture time", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const older = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
    capturedAt: new Date("2026-04-20T09:00:00Z"),
  });
  const newer = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/jpeg",
    bytes: TINY_PNG,
    capturedAt: new Date("2026-04-20T18:00:00Z"),
  });
  const foreign = await uploadPhoto(ctx.outsiderAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
  });

  // Ask in the wrong order + duplicate + foreign id
  const entries = await downloadableBatch(ctx.plannerAccess, [
    newer.id,
    older.id,
    older.id,
    foreign.id,
  ]);

  assert.deepEqual(
    entries.map((e) => e.id),
    [older.id, newer.id],
    "capture time ascending, foreign id dropped, dupes collapsed",
  );
  // Filename extensions match each row's own mime, not the batch's first one
  assert.match(entries[0].filename, /\.png$/);
  assert.match(entries[1].filename, /\.jpg$/);
});

test("downloadableBatch disambiguates filenames for photos captured in the same minute", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  const sameMinute = new Date("2026-04-20T09:00:00Z");
  const a = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
    capturedAt: sameMinute,
  });
  const b = await uploadPhoto(ctx.plannerAccess, {
    scope: "trip",
    mimeType: "image/png",
    bytes: TINY_PNG,
    capturedAt: sameMinute,
  });

  const entries = await downloadableBatch(ctx.plannerAccess, [a.id, b.id]);
  const names = new Set(entries.map((e) => e.filename));
  assert.equal(names.size, 2, "two same-minute photos get two distinct filenames");
});

test("an SVG upload is refused (see isAcceptablePhotoType)", async (t) => {
  const ctx = await setup();
  const { backend } = memoryBackend();
  installTestBackend(backend);
  t.after(async () => {
    resetBackend();
    await cleanupTrip(ctx.trip.id, []);
    await cleanupTrip(ctx.otherTrip.id, ctx.userIds);
  });

  await assert.rejects(
    () =>
      uploadPhoto(ctx.plannerAccess, {
        scope: "trip",
        mimeType: "image/svg+xml",
        bytes: new TextEncoder().encode("<svg/>"),
      }),
    /doesn't look like a photo/,
  );
});
