/**
 * Live flight status -- delays, gate/terminal, baggage claim -- via
 * AeroDataBox (https://aerodatabox.com/, accessed through RapidAPI).
 * Mirrors geocode.ts's shape: a missing AERODATABOX_API_KEY, a failed
 * request, or a flight AeroDataBox doesn't recognize all just return null
 * rather than throwing -- "no live update" degrades to "use the scheduled
 * time," which is a fact lib/transport-buffer.ts's schedule/leg data
 * already carries on its own.
 *
 * FlightStatusProvider is the swap-in point, same idea as travel.ts's
 * TravelTimeProvider: AeroDataBoxFlightStatusProvider is one
 * implementation; NoopFlightStatusProvider (always null, no network) is
 * what conflict analysis defaults to, so nothing calls out to a live API
 * unless a caller explicitly asks for it.
 *
 * NOTE: the response fields parsed below reflect AeroDataBox's documented
 * response shape as of this writing. This integration has not been
 * exercised against a real API key -- verify field names against a live
 * call (or AeroDataBox's OpenAPI schema) before relying on it in
 * production; toFlightStatus is written defensively (every field optional)
 * so a schema drift degrades to nulls/"unknown" rather than throwing.
 */

export type FlightStatusQuery = {
  /** e.g. "UA123" -- airline code + number, no space. */
  flightNumber: string;
  /** The flight's departure date, in the departure airport's local calendar date (YYYY-MM-DD) -- flight numbers are reused daily, so a lookup needs both. */
  departureDate: string;
};

export type FlightOperationalStatus =
  | "scheduled"
  | "active"
  | "landed"
  | "cancelled"
  | "diverted"
  | "unknown";

export type FlightStatus = {
  status: FlightOperationalStatus;
  /** Best current estimate, short of a confirmed actual -- null if nothing's been revised from schedule yet. */
  estimatedDepartsAt: Date | null;
  estimatedArrivesAt: Date | null;
  /** Confirmed actual (off-block/on-block, i.e. runway) time -- null until it's actually happened. */
  actualDepartsAt: Date | null;
  actualArrivesAt: Date | null;
  departureGate: string | null;
  departureTerminal: string | null;
  arrivalGate: string | null;
  arrivalTerminal: string | null;
  baggageClaim: string | null;
};

export interface FlightStatusProvider {
  /** Null means "no live update available" (unconfigured, not found, request failed) -- never an error; the caller already has the scheduled time to fall back to. */
  lookup(query: FlightStatusQuery): Promise<FlightStatus | null>;
}

/**
 * Default provider: always "no live update." No network, fully
 * deterministic -- what conflict analysis falls back to without an
 * explicit live provider, same "no external dependency, good enough to
 * make the logic testable" reasoning as HaversineTravelTimeProvider.
 */
export class NoopFlightStatusProvider implements FlightStatusProvider {
  async lookup(): Promise<null> {
    return null;
  }
}

/**
 * The best-known departure/arrival times for a leg, given its scheduled
 * times and (if looked up) a live status -- actual beats estimated beats
 * scheduled, decided independently per side, since a flight can depart on
 * time but still be airborne with only an arrival estimate so far.
 */
export function effectiveLegTimes(
  scheduled: { departsAt: Date; arrivesAt: Date },
  status: FlightStatus | null,
): { departsAt: Date; arrivesAt: Date } {
  if (!status) return scheduled;
  return {
    departsAt: status.actualDepartsAt ?? status.estimatedDepartsAt ?? scheduled.departsAt,
    arrivesAt: status.actualArrivesAt ?? status.estimatedArrivesAt ?? scheduled.arrivesAt,
  };
}

const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";
const AERODATABOX_URL = `https://${AERODATABOX_HOST}/flights/number`;

type AeroDataBoxTime = { utc?: string; local?: string };
type AeroDataBoxEndpoint = {
  scheduledTime?: AeroDataBoxTime;
  revisedTime?: AeroDataBoxTime;
  runwayTime?: AeroDataBoxTime;
  terminal?: string;
  gate?: string;
  baggageBelt?: string;
};
type AeroDataBoxFlight = {
  status?: string;
  departure?: AeroDataBoxEndpoint;
  arrival?: AeroDataBoxEndpoint;
};

/** AeroDataBox's UTC strings look like "2026-08-10 08:00Z" -- a space instead of "T" -- which Date can't parse directly. */
function parseUtc(time: AeroDataBoxTime | undefined): Date | null {
  if (!time?.utc) return null;
  const date = new Date(time.utc.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

const STATUS_MAP: Record<string, FlightOperationalStatus> = {
  expected: "scheduled",
  checkin: "scheduled",
  boarding: "scheduled",
  gateclosed: "scheduled",
  departed: "active",
  enroute: "active",
  approaching: "active",
  delayed: "active",
  arrived: "landed",
  canceled: "cancelled",
  cancelled: "cancelled",
  canceleduncertain: "cancelled",
  diverted: "diverted",
};

export function toFlightStatus(raw: AeroDataBoxFlight): FlightStatus {
  const normalized = raw.status?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return {
    status: STATUS_MAP[normalized] ?? "unknown",
    estimatedDepartsAt: parseUtc(raw.departure?.revisedTime),
    estimatedArrivesAt: parseUtc(raw.arrival?.revisedTime),
    actualDepartsAt: parseUtc(raw.departure?.runwayTime),
    actualArrivesAt: parseUtc(raw.arrival?.runwayTime),
    departureGate: raw.departure?.gate ?? null,
    departureTerminal: raw.departure?.terminal ?? null,
    arrivalGate: raw.arrival?.gate ?? null,
    arrivalTerminal: raw.arrival?.terminal ?? null,
    baggageClaim: raw.arrival?.baggageBelt ?? null,
  };
}

export class AeroDataBoxFlightStatusProvider implements FlightStatusProvider {
  async lookup(query: FlightStatusQuery): Promise<FlightStatus | null> {
    const apiKey = process.env.AERODATABOX_API_KEY;
    if (!apiKey) {
      console.warn(
        `[flight-status] AERODATABOX_API_KEY not set — skipping lookup for ${query.flightNumber}.`,
      );
      return null;
    }

    const url = `${AERODATABOX_URL}/${encodeURIComponent(query.flightNumber)}/${query.departureDate}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": AERODATABOX_HOST },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn(`[flight-status] request failed for ${query.flightNumber}:`, err);
      return null;
    }

    if (!response.ok) {
      console.warn(
        `[flight-status] AeroDataBox returned HTTP ${response.status} for ${query.flightNumber}.`,
      );
      return null;
    }

    // Multiple entries can come back for a shared flight number across
    // codeshares/aircraft swaps -- the first is AeroDataBox's primary record.
    const data = (await response.json()) as AeroDataBoxFlight[];
    const flight = data?.[0];
    return flight ? toFlightStatus(flight) : null;
  }
}
