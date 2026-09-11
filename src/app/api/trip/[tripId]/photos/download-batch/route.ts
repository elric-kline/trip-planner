import { Readable } from "node:stream";
// The @types/archiver package doesn't publish the callable-factory
// signature (`archiver("zip", ...)`), only the class. Using the class
// directly gets us the same runtime object with clean typings.
import { ZipArchive } from "archiver";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { downloadableBatch, MAX_BATCH_PHOTOS } from "@/lib/photos.ts";
import { getObject } from "@/lib/r2.ts";
import { RuleError } from "@/lib/items.ts";

/**
 * Streams a zip of the requested photos back to the client. The viewer
 * calls this from the gallery's bulk-select toolbar (see
 * PhotoJournal.tsx's SelectionBar); the response body is one zip entry
 * per photo in `ids`, ordered by capture time (see
 * lib/photos.ts's downloadableBatch).
 *
 * Design notes:
 *   - store mode (no compression). JPEG/PNG/WebP are already compressed,
 *     so deflate would burn CPU for a rounding-error-sized saving.
 *   - archiver streams as it writes -- we don't buffer the whole zip in
 *     memory. Each R2 fetch is awaited only as its bytes are about to go
 *     into the stream, so overall memory use stays bounded to roughly one
 *     photo at a time regardless of batch size.
 *   - Same "silently 404 rather than confirm what exists" posture as
 *     /view and /download: no auth, or the trip id isn't the viewer's,
 *     returns Not Found rather than 401/403.
 *   - MAX_BATCH_PHOTOS is a real ceiling (200); a bigger request is
 *     refused with a clear message rather than silently truncated.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("Not found.", { status: 404 });

  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, user);
  } catch (err) {
    if (err instanceof AccessError) return new Response("Not found.", { status: 404 });
    throw err;
  }

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids") ?? "";
  const requestedIds = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (requestedIds.length === 0) {
    return Response.json({ error: "Pick at least one photo." }, { status: 400 });
  }
  if (requestedIds.length > MAX_BATCH_PHOTOS) {
    return Response.json(
      { error: `Pick at most ${MAX_BATCH_PHOTOS} photos at a time.` },
      { status: 400 },
    );
  }

  let entries;
  try {
    entries = await downloadableBatch(access, requestedIds);
  } catch (err) {
    if (err instanceof RuleError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  if (entries.length === 0) return new Response("Not found.", { status: 404 });

  const zip = new ZipArchive({ store: true });
  // archiver is a Node Readable; wrap it in a Web ReadableStream so a Next
  // Route Handler can return it as the response body.
  const stream = Readable.toWeb(zip) as ReadableStream<Uint8Array>;

  // Kick off appending entries in the background. Errors reaching R2 are
  // fed to `zip.abort()` -- that ends the stream with a zip-level error
  // marker, which is the best signal a partial download has to say "don't
  // trust this file." We don't try to recover by skipping the failed
  // photo; a batch that silently omits one photo is worse than a batch
  // the browser marks as broken.
  (async () => {
    try {
      for (const entry of entries) {
        const { bytes } = await getObject(entry.storageKey);
        zip.append(Buffer.from(bytes), { name: entry.filename });
      }
      await zip.finalize();
    } catch (err) {
      console.warn("[photos] batch zip failed mid-stream", err);
      zip.abort();
    }
  })();

  const zipFilename = `trip-photos-${new Date().toISOString().slice(0, 10)}.zip`;
  const encoded = encodeURIComponent(zipFilename);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFilename}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    },
  });
}
