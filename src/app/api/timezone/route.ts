import { getCurrentUser } from "@/lib/auth.ts";
import { describeTimezone, timezoneForPlace } from "@/lib/timezone.ts";

/**
 * Which zone a destination sits in, so the new-trip form can resolve it while
 * somebody types rather than asking them for an IANA id.
 *
 * Same signed-in gate as the other Maps-backed routes: it keeps
 * GOOGLE_MAPS_API_KEY server-side and keeps the quota from being spendable by
 * anyone anonymous. A place that can't be resolved comes back as nulls, not an
 * error -- the form falls back to the browser's own zone.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ timezone: null, label: null }, { status: 401 });

  const place = new URL(request.url).searchParams.get("place") ?? "";
  const timezone = place.trim() ? await timezoneForPlace(place) : null;
  return Response.json({ timezone, label: timezone ? describeTimezone(timezone) : null });
}
