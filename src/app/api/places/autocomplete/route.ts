import { getCurrentUser } from "@/lib/auth.ts";
import { autocompleteAddress, autocompletePlace } from "@/lib/places.ts";

/**
 * Proxies the browser's keystrokes to Google so GOOGLE_MAPS_API_KEY never
 * has to leave the server. Requires a signed-in session -- this fires on
 * every keystroke, and an unauthenticated version of that would let anyone
 * on the internet spend the trip's Google Maps quota.
 *
 * `restrict=place` narrows results to cities/towns/villages (see
 * places.ts's autocompletePlace) -- used by a trip day's wake/sleep/stop
 * fields (AddressAutocomplete's `restrict` prop), which want "which town,"
 * not a street address. Any other value, including none, is the original
 * unrestricted address lookup an Activity/Lodging/Dining item's own
 * location field still uses.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ suggestions: [] }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const input = params.get("input") ?? "";
  const suggestions =
    params.get("restrict") === "place" ? await autocompletePlace(input) : await autocompleteAddress(input);
  return Response.json({ suggestions });
}
