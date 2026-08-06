/**
 * Turns free-text (an address, a hotel name, a landmark) into coordinates via
 * the Google Maps Geocoding API — the thing that used to require a user to
 * type latitude/longitude by hand.
 *
 * Mirrors email.ts's shape: a missing GOOGLE_MAPS_API_KEY, a request that
 * fails, or an address Google can't resolve all just return null rather than
 * throwing. A missing location is something the conflict engine already
 * treats as "unanalyzable, not an error" (see conflicts.ts) — geocoding
 * failure should degrade the same way, not block creating or editing an
 * item.
 */
const GEOCODE_API_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export type GeocodeResult = { lat: number; lng: number };

type GoogleGeocodeResponse = {
  status: string;
  results?: Array<{
    geometry?: { location?: { lat?: number; lng?: number } };
  }>;
};

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const q = query.trim();
  if (!q) return null;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn(`[geocode] GOOGLE_MAPS_API_KEY not set — skipping lookup for "${q}".`);
    return null;
  }

  const url = `${GEOCODE_API_URL}?address=${encodeURIComponent(q)}&key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[geocode] request failed for "${q}":`, err);
    return null;
  }

  if (!response.ok) {
    console.warn(`[geocode] Google API returned HTTP ${response.status} for "${q}".`);
    return null;
  }

  const data = (await response.json()) as GoogleGeocodeResponse;
  if (data.status !== "OK") {
    if (data.status !== "ZERO_RESULTS") {
      console.warn(`[geocode] Google API status "${data.status}" for "${q}".`);
    }
    return null;
  }

  const location = data.results?.[0]?.geometry?.location;
  if (typeof location?.lat !== "number" || typeof location?.lng !== "number") return null;

  return { lat: location.lat, lng: location.lng };
}
