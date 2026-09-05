import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 storage adapter.
 *
 * R2 speaks the S3 protocol, so we lean on @aws-sdk/client-s3 rather than
 * hand-rolling AWS signature v4. The one R2-shaped bit is the endpoint --
 * https://<accountId>.r2.cloudflarestorage.com -- and `region: "auto"`, which
 * R2 accepts on every request.
 *
 * Everything a caller does goes through the four exported functions below.
 * They deliberately never expose the S3Client itself: keeping the surface
 * narrow means an accidentally-added HeadObject/ListObjects call somewhere
 * else in the codebase can't leak information the app has no reason to hand
 * out. If a new operation is genuinely needed later, add it here.
 *
 * Uploaded objects live under `photos/<tripId>/<photoId>` so a manual sweep
 * for "everything belonging to this trip" is a bucket-prefix listing rather
 * than a DB scan; individual downloads still go through app-issued presigned
 * GET URLs (see `signedGetUrl`), never a raw bucket URL.
 */

export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Photo storage isn't configured yet — ask whoever runs this app to set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET before uploading anything.",
    );
  }
}

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Optional public read-only base URL for a bucket that's been made public
   * (e.g. a Cloudflare R2 custom domain). When set, `signedGetUrl` can hand
   * out a plain public URL instead of a presigned one for content whose only
   * access rule is "already got past the app's own auth to see it." Off by
   * default -- everything goes through a short-lived presigned URL.
   */
  publicBaseUrl?: string | undefined;
};

function readConfig(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim() || undefined,
  };
}

/**
 * Whether the four required env vars are set -- or a test backend has been
 * installed. Callers use this to decide between "silently no-op" (e.g. a
 * listPhotos on an unconfigured deploy just returns an empty list) and
 * "refuse loudly" (an uploadPhoto without storage raises this to the user).
 */
export function isStorageConfigured(): boolean {
  if (backend !== null) return true;
  return readConfig() !== null;
}

function requireConfig(): R2Config {
  const cfg = readConfig();
  if (!cfg) throw new StorageNotConfiguredError();
  return cfg;
}

// One client per process, lazily built on first use. Rebuilt across `next
// dev`'s module reloads via the same globalThis trick db/index.ts uses.
const globalForR2 = globalThis as unknown as {
  __r2Client?: { client: S3Client; bucket: string };
};

function client(): { client: S3Client; bucket: string } {
  if (globalForR2.__r2Client) return globalForR2.__r2Client;
  const cfg = requireConfig();
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // R2 only supports path-style addressing; forceLookup below sidesteps
    // the SDK's default of switching to virtual-hosted style for anything
    // that looks like an S3 endpoint.
    forcePathStyle: true,
  });
  const built = { client: s3, bucket: cfg.bucket };
  if (process.env.NODE_ENV !== "production") globalForR2.__r2Client = built;
  return built;
}

/** Object key convention: photos live under a per-trip prefix, so a bucket-prefix listing recovers every object for a trip without touching the DB. */
export function objectKeyFor(tripId: string, photoId: string): string {
  return `photos/${tripId}/${photoId}`;
}

/**
 * The four operations lib/photos.ts actually needs, factored out as an
 * interface so tests can plug an in-memory bucket in behind them without
 * every code path having to know about the swap. Production wires this up
 * to the real R2 client on first use (see `defaultBackend` below);
 * `installTestBackend` replaces it, and `resetBackend` puts the real one
 * back.
 */
export type StorageBackend = {
  putObject(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  signedGetUrl(key: string, ttlSeconds?: number): Promise<string>;
};

function defaultBackend(): StorageBackend {
  return {
    async putObject(key, bytes, mimeType) {
      const { client: s3, bucket } = client();
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
        }),
      );
    },
    async deleteObject(key) {
      const { client: s3, bucket } = client();
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (status === 404) return;
        throw err;
      }
    },
    async deleteObjects(keys) {
      if (keys.length === 0) return;
      const { client: s3, bucket } = client();
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
    async signedGetUrl(key, ttlSeconds = 300) {
      const cfg = requireConfig();
      if (cfg.publicBaseUrl) {
        const base = cfg.publicBaseUrl.replace(/\/$/, "");
        return `${base}/${key}`;
      }
      const { client: s3, bucket } = client();
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },
  };
}

let backend: StorageBackend | null = null;

function activeBackend(): StorageBackend {
  if (!backend) backend = defaultBackend();
  return backend;
}

/** Replace the storage backend -- tests only. Pair with resetBackend() in an afterEach/t.after so nothing leaks between tests. */
export function installTestBackend(stub: StorageBackend): void {
  backend = stub;
}

/** Restores the default (real R2) backend. */
export function resetBackend(): void {
  backend = null;
}

/** Uploads bytes to R2. Overwrites in place -- the (tripId, photoId) key is unique per photo, so an overwrite is by definition intentional. */
export function putObject(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  return activeBackend().putObject(key, bytes, mimeType);
}

/** Removes one object. Not a hard error if it isn't there -- a DB row without a matching object is a case the caller might be trying to clean up. */
export function deleteObject(key: string): Promise<void> {
  return activeBackend().deleteObject(key);
}

/** Batch delete, capped by S3's own DeleteObjects limit of 1000 keys per call. */
export function deleteObjects(keys: string[]): Promise<void> {
  return activeBackend().deleteObjects(keys);
}

/**
 * A short-lived presigned URL an `<img src>` can fetch directly from R2 --
 * we hand this out only after the app's own scope check has passed (see
 * lib/photos.ts's viewablePhotoUrl). 5 minutes is enough for a page load and
 * a couple of retries; longer risks the URL surviving out of an authorized
 * session if someone screenshots or shares dev tools.
 *
 * If R2_PUBLIC_BASE_URL is set (a bucket-with-a-public-domain deploy), the
 * URL is a plain public one and the "already got past the app's own auth"
 * gate is doing the whole job -- no signature needed.
 */
export function signedGetUrl(key: string, ttlSeconds = 300): Promise<string> {
  return activeBackend().signedGetUrl(key, ttlSeconds);
}
