export type Coordinates = { lat: number; lng: number };
export type TravelMode = "walk" | "drive" | "transit";

export type TravelEstimate = {
  minutes: number;
  mode: TravelMode;
  /**
   * Time to budget beyond the drive/walk itself — parking, boarding, walking
   * from the car or stop to the actual door. This is what turns an
   * on-paper-fine gap into "tight at best."
   */
  overheadMinutes: number;
};

/**
 * Swappable source of travel-time estimates. The conflict engine only depends
 * on this interface, so a real router (Google Routes, Mapbox) is a drop-in
 * replacement for HaversineTravelTimeProvider — same call, no engine changes.
 */
export interface TravelTimeProvider {
  estimate(from: Coordinates, to: Coordinates, mode: TravelMode): Promise<TravelEstimate>;
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Straight-line distance × a mode factor, since real roads aren't straight. */
const MODE_KMH: Record<TravelMode, number> = { walk: 4.5, drive: 28, transit: 18 };
const ROUTE_FACTOR = 1.35;
/** Parking, boarding, walking from the door — see TravelEstimate.overheadMinutes. */
const MODE_OVERHEAD_MIN: Record<TravelMode, number> = { walk: 0, drive: 10, transit: 8 };

/**
 * No API key, fully deterministic, good enough to make the conflict engine's
 * logic testable. Replace with a real router when accuracy on actual roads
 * and live traffic matters more than having zero external dependencies.
 */
export class HaversineTravelTimeProvider implements TravelTimeProvider {
  private cache = new Map<string, TravelEstimate>();

  async estimate(from: Coordinates, to: Coordinates, mode: TravelMode): Promise<TravelEstimate> {
    const key = `${from.lat},${from.lng}|${to.lat},${to.lng}|${mode}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const km = haversineKm(from, to) * ROUTE_FACTOR;
    const minutes = Math.round((km / MODE_KMH[mode]) * 60);
    const result: TravelEstimate = { minutes, mode, overheadMinutes: MODE_OVERHEAD_MIN[mode] };
    this.cache.set(key, result);
    return result;
  }
}

/** Picks a plausible mode from distance alone, absent explicit user input. */
export function inferMode(from: Coordinates, to: Coordinates): TravelMode {
  const km = haversineKm(from, to);
  if (km < 1.2) return "walk";
  if (km < 6) return "transit";
  return "drive";
}
