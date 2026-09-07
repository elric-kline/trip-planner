import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { downloadablePhoto } from "@/lib/photos.ts";

/**
 * The URL the lightbox's "Save" button actually fetches. Streams the R2
 * object's bytes back with `Content-Disposition: attachment` so the
 * browser downloads instead of navigating -- and same-origin, so the
 * client-side `navigator.share({ files })` path can read the body as a
 * blob and hand it to the OS share sheet (no CORS dance against the R2
 * bucket).
 *
 * Auth is the same trip-scope check as /view: a mismatched (tripId,
 * photoId) or a non-member reads as 404, matching the passport-photo
 * route's "don't confirm what exists" posture.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tripId: string; photoId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("Not found.", { status: 404 });

  const { tripId, photoId } = await params;
  try {
    const access = await requireTripAccess(tripId, user);
    const photo = await downloadablePhoto(access, photoId);
    if (!photo) return new Response("Not found.", { status: 404 });

    // Filename is UTF-8; use RFC 5987's filename* form alongside the plain
    // one so an old browser still gets *a* filename and a current one gets
    // the correctly-decoded one.
    const encoded = encodeURIComponent(photo.filename);
    return new Response(new Uint8Array(photo.bytes), {
      headers: {
        "Content-Type": photo.mimeType,
        "Content-Disposition": `attachment; filename="${photo.filename}"; filename*=UTF-8''${encoded}`,
        // Private -- a signed-in viewer's download shouldn't sit in a
        // shared cache between viewers.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AccessError) return new Response("Not found.", { status: 404 });
    throw err;
  }
}
