import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { getPassportPhoto, canViewMemberPassport } from "@/lib/passport.ts";

/**
 * Serves a fellow trip member's passport photo -- deliberately its own
 * lazy, authenticated route rather than inlined as a data: URI in the
 * People list (see the trip page's own comment on why): the bytes only
 * ever leave the server when a planner actually clicks "view photo" for
 * one specific person, not on every load of a list that might show
 * several members at once.
 *
 * Gated the same way the People list itself decides whether to show the
 * "view photo" link at all -- canViewMemberPassport, trip-scoped. A
 * mismatched or unauthorized (tripId, userId) pair reads as a plain 404,
 * not 403 -- same "don't confirm what exists" posture as
 * requireTripAccess's own NOT_FOUND for a trip a non-member probes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ tripId: string; userId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("Not found.", { status: 404 });

  const { tripId, userId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, user);
  } catch (err) {
    if (err instanceof AccessError) return new Response("Not found.", { status: 404 });
    throw err;
  }

  if (!canViewMemberPassport(access, userId)) return new Response("Not found.", { status: 404 });

  const photo = await getPassportPhoto(userId);
  if (!photo) return new Response("Not found.", { status: 404 });

  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.mimeType,
      // Private -- this is somebody's identity document, never a shared/public asset a CDN or browser should cache alongside anything else.
      "Cache-Control": "private, no-store",
    },
  });
}
