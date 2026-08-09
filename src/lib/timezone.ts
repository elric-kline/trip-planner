import { geocodeAddress } from "./geocode.ts";

/**
 * Works out which IANA timezone a place is in, so nobody has to know that
 * "Oaxaca, Mexico" means `America/Mexico_City`.
 *
 * The trip form used to ask for that string outright, as a required field
 * prefilled with `America/Mexico_City` no matter where the trip was going.
 * Miss it and every time on the trip is silently wrong -- and since the
 * timezone is what `localInputToDate` interprets every `datetime-local` value
 * against, that means the conflict engine reasoning about the wrong hours.
 * Wrong quietly, which is the worst way for a schedule to be wrong.
 *
 * Same failure posture as geocode.ts: no key, a failed request, or a place
 * Google can't place all return null. The caller decides what to do about it
 * (see trips/actions.ts, which falls back to the browser's own zone) rather
 * than a lookup failure blocking trip creation.
 */
const TIMEZONE_API_URL = "https://maps.googleapis.com/maps/api/timezone/json";

type GoogleTimezoneResponse = {
  status: string;
  errorMessage?: string;
  timeZoneId?: string;
};

/**
 * The canonical IANA id for whatever the caller has, or null if Intl can't
 * make sense of it at all.
 *
 * Canonicalising matters because Intl also accepts legacy abbreviations, and
 * resolves them in ways nobody expects: "CST" is America/Chicago, and "EST"
 * is *America/Panama* -- which never observes DST, so a trip stored as "EST"
 * would drift an hour away from New York for half the year. Storing what Intl
 * actually resolved means the value in the database is the one the formatter
 * will use, with no abbreviation left to reinterpret later.
 */
export function canonicalTimezone(id: string): string | null {
  if (!id.trim()) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: id.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Cheap sanity check -- Intl throws on an id it doesn't know. */
export function isValidTimezone(id: string): boolean {
  return canonicalTimezone(id) !== null;
}

/**
 * Whether a hand-typed zone can be trusted, and what to store for it.
 *
 * Intl accepts bare abbreviations, and resolving them is a trap rather than a
 * convenience: "EST" is not US Eastern, it's `America/Panama`, which never
 * observes DST -- so a New York trip stored that way runs an hour off for half
 * the year, quietly. "CST" is America/Chicago, which is probably what someone
 * meant, but only by luck.
 *
 * Region/city ids don't have that problem, including the legacy aliases:
 * `US/Eastern` resolves to `America/New_York`, which is what anyone typing it
 * intended. So the rule is the shape, not the alias-ness -- anything with a
 * region prefix is accepted and stored canonically; a bare abbreviation is
 * refused with a message rather than silently resolved to somewhere else.
 */
export function acceptTypedTimezone(raw: string): { ok: true; id: string } | { ok: false; reason: string } {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "Give a time zone." };

  const canonical = canonicalTimezone(input);
  if (!canonical) {
    return { ok: false, reason: `"${input}" isn't a time zone we recognise. Try something like America/Mexico_City.` };
  }

  if (!input.includes("/") && input.toUpperCase() !== "UTC") {
    return {
      ok: false,
      reason: `Use a region/city time zone like ${canonical}, not an abbreviation — "${input.toUpperCase()}" means ${canonical} to the system, which may not be where you mean.`,
    };
  }

  return { ok: true, id: canonical };
}

export async function timezoneForCoordinates(lat: number, lng: number): Promise<string | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[timezone] GOOGLE_MAPS_API_KEY not set — skipping lookup.");
    return null;
  }

  // The API needs an instant to resolve against, since a zone's offset moves
  // with DST. Which instant barely matters here: we want the zone id, not the
  // offset, and a zone id doesn't change across the year.
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${TIMEZONE_API_URL}?location=${lat},${lng}&timestamp=${timestamp}&key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[timezone] request failed for ${lat},${lng}:`, err);
    return null;
  }

  if (!response.ok) {
    console.warn(`[timezone] Google API returned HTTP ${response.status} for ${lat},${lng}.`);
    return null;
  }

  const data = (await response.json()) as GoogleTimezoneResponse;
  if (data.status !== "OK") {
    if (data.status !== "ZERO_RESULTS") {
      console.warn(
        `[timezone] Google API status "${data.status}"${data.errorMessage ? `: ${data.errorMessage}` : ""}`,
      );
    }
    return null;
  }

  return data.timeZoneId ? canonicalTimezone(data.timeZoneId) : null;
}

/** Geocodes free text, then asks which zone those coordinates sit in. */
export async function timezoneForPlace(place: string): Promise<string | null> {
  const coords = await geocodeAddress(place);
  if (!coords) return null;
  return timezoneForCoordinates(coords.lat, coords.lng);
}

/**
 * How a zone should be shown to somebody who doesn't think in IANA ids --
 * "Central Standard Time" rather than "America/Mexico_City". Falls back to the
 * id itself if Intl can't name it, which is still better than nothing.
 */
export function describeTimezone(id: string, when: Date = new Date()): string {
  if (!isValidTimezone(id)) return id;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: id,
    timeZoneName: "long",
  }).formatToParts(when);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? id;
}
