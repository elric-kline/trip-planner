import { getCurrentUser } from "@/lib/auth.ts";
import { getPlaceDetails } from "@/lib/places.ts";

/**
 * Fetched once, right after a restaurant search suggestion is selected --
 * not per keystroke like autocomplete/search-restaurant, but the same
 * signed-in gate applies for the same reason: keep GOOGLE_MAPS_API_KEY
 * server-side and keep the quota from being spendable by anyone anonymous.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ details: null }, { status: 401 });

  const placeId = new URL(request.url).searchParams.get("placeId") ?? "";
  const details = await getPlaceDetails(placeId);
  return Response.json({ details });
}
