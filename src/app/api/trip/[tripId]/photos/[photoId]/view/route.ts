import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { viewablePhotoUrl } from "@/lib/photos.ts";

/**
 * The URL an `<img src>` actually fetches. Redirects to a short-lived
 * presigned R2 URL after checking that the viewer is on the trip and the
 * photo id really belongs to it. A mismatched (tripId, photoId) or a
 * non-member returns 404, same "don't confirm what exists" posture as
 * the passport-photo route.
 *
 * The redirect is 302 rather than 301 -- the underlying signed URL
 * rotates every few minutes; a cached 301 to a URL that will soon 403
 * from R2 would be worse than fetching this cheap endpoint again.
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
    const view = await viewablePhotoUrl(access, photoId);
    if (!view) return new Response("Not found.", { status: 404 });
    return Response.redirect(view.url, 302);
  } catch (err) {
    if (err instanceof AccessError) return new Response("Not found.", { status: 404 });
    throw err;
  }
}
