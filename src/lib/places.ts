/**
 * Address suggestions as you type, via the same Google Maps Platform key as
 * geocode.ts (the project just needs the "Places API" enabled alongside
 * "Geocoding API" — no separate key or account). Same failure shape too: a
 * missing key, a bad request, or a network error all just mean no
 * suggestions rather than a broken input. Selecting a suggestion only fills
 * in text; the actual coordinates still come from geocodeAddress() when the
 * form is submitted, so autocomplete failing never blocks anything.
 */
const AUTOCOMPLETE_API_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json";

/** Below this, predictions are mostly noise and it's not worth the request. */
const MIN_QUERY_LENGTH = 3;

export type PlaceSuggestion = { description: string; placeId: string };

type GoogleAutocompleteResponse = {
  status: string;
  predictions?: Array<{ description?: string; place_id?: string }>;
};

export async function autocompleteAddress(input: string): Promise<PlaceSuggestion[]> {
  const q = input.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn(`[places] GOOGLE_MAPS_API_KEY not set — skipping autocomplete for "${q}".`);
    return [];
  }

  const url = `${AUTOCOMPLETE_API_URL}?input=${encodeURIComponent(q)}&key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[places] request failed for "${q}":`, err);
    return [];
  }

  if (!response.ok) {
    console.warn(`[places] Google API returned HTTP ${response.status} for "${q}".`);
    return [];
  }

  const data = (await response.json()) as GoogleAutocompleteResponse;
  if (data.status !== "OK") {
    if (data.status !== "ZERO_RESULTS") {
      console.warn(`[places] Google API status "${data.status}" for "${q}".`);
    }
    return [];
  }

  return (data.predictions ?? [])
    .filter((p): p is { description: string; place_id: string } => Boolean(p.description && p.place_id))
    .map((p) => ({ description: p.description, placeId: p.place_id }));
}
