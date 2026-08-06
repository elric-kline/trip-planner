import { getCurrentUser } from "@/lib/auth.ts";
import { searchRestaurants } from "@/lib/places.ts";

/**
 * Same shape as /api/places/autocomplete, restricted to establishments and
 * biased by the trip's destination text — see searchRestaurants() for why
 * that's text-appended rather than a lat/lng bias.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ suggestions: [] }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const input = params.get("input") ?? "";
  const destination = params.get("destination") ?? "";
  const suggestions = await searchRestaurants(input, destination);
  return Response.json({ suggestions });
}
