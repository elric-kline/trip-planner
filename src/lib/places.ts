/**
 * Address and restaurant lookups via the same Google Maps Platform key as
 * geocode.ts (the project just needs "Places API" enabled alongside
 * "Geocoding API" — no separate key or account). Same failure shape
 * throughout: a missing key, a bad request, or a network error all just mean
 * no suggestions/details rather than a broken input — nothing here ever
 * blocks saving or editing an item.
 */
const AUTOCOMPLETE_API_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const DETAILS_API_URL = "https://maps.googleapis.com/maps/api/place/details/json";

/** Below this, predictions are mostly noise and it's not worth the request. */
const MIN_QUERY_LENGTH = 3;

export type PlaceSuggestion = { description: string; placeId: string };

type GoogleAutocompleteResponse = {
  status: string;
  error_message?: string;
  predictions?: Array<{ description?: string; place_id?: string }>;
};

/** Shared by autocompleteAddress and searchRestaurants -- same endpoint, same response shape, different query/types. */
async function placeAutocomplete(input: string, types?: string): Promise<PlaceSuggestion[]> {
  const q = input.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn(`[places] GOOGLE_MAPS_API_KEY not set — skipping autocomplete for "${q}".`);
    return [];
  }

  const params = new URLSearchParams({ input: q, key: apiKey });
  if (types) params.set("types", types);
  const url = `${AUTOCOMPLETE_API_URL}?${params}`;

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
      // error_message is where Google actually says *why* -- e.g. "This API
      // project is not authorized to use this API" (the legacy Places API
      // is a separate enablement from "Places API (New)") vs. a key
      // restriction rejecting a server-side call. The bare status alone
      // isn't enough to tell those apart.
      console.warn(
        `[places] Google API status "${data.status}" for "${q}"${data.error_message ? `: ${data.error_message}` : ""}`,
      );
    }
    return [];
  }

  return (data.predictions ?? [])
    .filter((p): p is { description: string; place_id: string } => Boolean(p.description && p.place_id))
    .map((p) => ({ description: p.description, placeId: p.place_id }));
}

export async function autocompleteAddress(input: string): Promise<PlaceSuggestion[]> {
  return placeAutocomplete(input);
}

/**
 * Restricted to Google's "(regions)" type collection -- localities,
 * sublocalities, postal codes, and administrative areas, not street
 * addresses or businesses. Used for a trip day's wake/sleep/stop
 * locations, which are meant to answer "which place," not a precise
 * address -- that's what an Activity/Lodging/Dining item's own location
 * field is for, and stays on the unrestricted autocompleteAddress.
 *
 * Deliberately "(regions)", not the narrower "(cities)": "(cities)" only
 * matches Google's `locality` type -- an incorporated municipality -- and
 * excludes anything Google classifies as a `sublocality`, which is where a
 * borough like Brooklyn lives in its data model (administratively part of
 * New York City, not its own city) despite being exactly the kind of place
 * someone would type here. "(regions)" includes sublocality alongside
 * locality, so it doesn't have that gap.
 */
export async function autocompletePlace(input: string): Promise<PlaceSuggestion[]> {
  return placeAutocomplete(input, "(regions)");
}

/**
 * "Which restaurant did they mean" — restricted to real places (not raw
 * addresses) and biased toward the trip's destination by appending it to the
 * query text. No trip-level lat/lng exists to bias by coordinates instead
 * (see schema.ts's trips table), and in practice combined text like
 * "Sushi Saito, Tokyo" resolves just as well through this same endpoint.
 */
export async function searchRestaurants(query: string, destination: string): Promise<PlaceSuggestion[]> {
  const d = destination.trim();
  const combined = d ? `${query} ${d}` : query;
  return placeAutocomplete(combined, "establishment");
}

export type PlaceDetails = {
  name: string | null;
  formattedAddress: string | null;
  phone: string | null;
  website: string | null;
  /** Google's 0 (free) - 4 (very expensive) scale; null when the venue hasn't reported one. */
  priceLevel: number | null;
  /** The point Places itself resolved this to -- what lets a caller (e.g. lib/assistant.ts's get_place_details tool) reason about travel time or save a real location without a second, separately-fallible geocode of the formatted address. */
  lat: number | null;
  lng: number | null;
};

type GoogleDetailsResponse = {
  status: string;
  error_message?: string;
  result?: {
    name?: string;
    formatted_address?: string;
    formatted_phone_number?: string;
    website?: string;
    price_level?: number;
    geometry?: { location?: { lat?: number; lng?: number } };
  };
};

/**
 * Fetched only once a suggestion is actually selected — not per keystroke,
 * unlike autocomplete. Deliberately does NOT attempt cuisine or dietary
 * fields: Places' own data here is either absent or too coarse (a generic
 * "restaurant"/"food" type, not "Neapolitan pizza") to respect trusting
 * silently. That inference is the LLM web-read step, a separate piece.
 */
export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const id = placeId.trim();
  if (!id) return null;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn(`[places] GOOGLE_MAPS_API_KEY not set — skipping details lookup for "${id}".`);
    return null;
  }

  const params = new URLSearchParams({
    place_id: id,
    fields: "name,formatted_address,formatted_phone_number,website,price_level,geometry",
    key: apiKey,
  });
  const url = `${DETAILS_API_URL}?${params}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[places] details request failed for "${id}":`, err);
    return null;
  }

  if (!response.ok) {
    console.warn(`[places] Google Details API returned HTTP ${response.status} for "${id}".`);
    return null;
  }

  const data = (await response.json()) as GoogleDetailsResponse;
  if (data.status !== "OK") {
    console.warn(
      `[places] Google Details API status "${data.status}" for "${id}"${data.error_message ? `: ${data.error_message}` : ""}`,
    );
    return null;
  }

  const result = data.result ?? {};
  const location = result.geometry?.location;
  return {
    name: result.name ?? null,
    formattedAddress: result.formatted_address ?? null,
    phone: result.formatted_phone_number ?? null,
    website: result.website ?? null,
    priceLevel: typeof result.price_level === "number" ? result.price_level : null,
    lat: typeof location?.lat === "number" ? location.lat : null,
    lng: typeof location?.lng === "number" ? location.lng : null,
  };
}
