import { getCurrentUser } from "@/lib/auth.ts";
import { autocompleteAddress } from "@/lib/places.ts";

/**
 * Proxies the browser's keystrokes to Google so GOOGLE_MAPS_API_KEY never
 * has to leave the server. Requires a signed-in session -- this fires on
 * every keystroke, and an unauthenticated version of that would let anyone
 * on the internet spend the trip's Google Maps quota.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ suggestions: [] }, { status: 401 });

  const input = new URL(request.url).searchParams.get("input") ?? "";
  const suggestions = await autocompleteAddress(input);
  return Response.json({ suggestions });
}
