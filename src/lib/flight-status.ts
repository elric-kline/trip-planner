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
 * Path, params, and response fields below are checked against AeroDataBox's
 * published OpenAPI spec (the "Number/Reg/CallSign/Icao24" FlightSearchByEnum
 * and FlightAirportMovementContract schemas -- see GetFlight_FlightOnSpecificDate),
 * not against a live call with a real key -- this account has no traffic on
 * it yet. toFlightStatus is written defensively (every field optional) so
 * any remaining schema drift degrades to nulls/"unknown" rather than
 * throwing, but treat the exact field names as "spec-checked," not
 * "observed," until a real response has actually been logged once.
 *
 * NOTE: GetBalance (GET /subscriptions/balance) is NOT this API -- per the
 * spec it's the Flight Alert (webhook) product's own credit system,
 * explicitly separate from the RapidAPI marketplace quota that flight
 * status lookups here are billed against. Checking it tells you nothing
 * about whether these calls are working.
 */

export type FlightStatusQuery = {
  /** e.g. "UA123" -- airline code + number, no space. */
  flightNumber: string;
  /**
   * The flight's departure date as YYYY-MM-DD. AeroDataBox's dateLocal
   * parameter wants the *airport-local* calendar date; what's actually
   * passed here (see conflicts-for.ts's utcCalendarDate) is the UTC date of
   * the leg's stored departsAt instant -- transport_legs has no per-airport
   * timezone to compute the true local date from. AeroDataBoxFlightStatusProvider
   * covers the gap by also trying the adjacent calendar days (see
   * candidateDates below), since a UTC offset can shift the local date by
   * at most one day either way.
   */
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

/**
 * `dateLocal` and its two neighbors, as YYYY-MM-DD, given first -- a UTC
 * offset is at most ±14 hours, so an airport's local calendar date can
 * differ from a UTC-derived date by at most one day in either direction,
 * never two. Trying all three is how AeroDataBoxFlightStatusProvider
 * covers for not knowing the departure airport's actual timezone (see
 * FlightStatusQuery.departureDate).
 */
export function candidateDates(dateLocal: string): string[] {
  const base = new Date(`${dateLocal}T00:00:00Z`);
  const shift = (days: number) => {
    const d = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  };
  return [dateLocal, shift(-1), shift(1)];
}

const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";
/** GET /flights/{searchBy}/{searchParam}/{dateLocal} -- searchBy is a case-sensitive enum (Number/Reg/CallSign/Icao24); "Number" is what a flight-number lookup needs. */
const AERODATABOX_FLIGHTS_URL = `https://${AERODATABOX_HOST}/flights/Number`;

type AeroDataBoxTime = { utc?: string; local?: string };
/**
 * FlightAirportMovementContract per the spec. revisedTime is the
 * airline/ATC-confirmed current estimate; runwayTime is the confirmed
 * actual (off-block/on-block). The schema also has a predictedTime
 * (AeroDataBox's own model, ahead of an official revision) and
 * checkInDesk/runway -- not consumed here; add them if "estimated" should
 * ever prefer a prediction over waiting for an official revision.
 */
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

/** A hard failure (no key, request error, non-OK HTTP) vs. "asked AeroDataBox and it had nothing for that date" -- only the latter is worth retrying on a neighboring date. */
type DateQueryResult = { ok: true; flights: AeroDataBoxFlight[] } | { ok: false };

export class AeroDataBoxFlightStatusProvider implements FlightStatusProvider {
  async lookup(query: FlightStatusQuery): Promise<FlightStatus | null> {
    const apiKey = process.env.AERODATABOX_API_KEY;
    if (!apiKey) {
      console.warn(
        `[flight-status] AERODATABOX_API_KEY not set — skipping lookup for ${query.flightNumber}.`,
      );
      return null;
    }

    // Try the given date first, then its two neighbors -- see
    // candidateDates for why a local-date mismatch is never more than one
    // day off. Stops at the first date with a result; a hard failure on
    // any attempt (bad key, network error, non-OK HTTP) aborts the whole
    // lookup rather than burning quota on dates that won't fare any better.
    for (const date of candidateDates(query.departureDate)) {
      const result = await this.queryDate(query.flightNumber, date, apiKey);
      if (!result.ok) return null;
      if (result.flights.length > 0) return toFlightStatus(result.flights[0]);
    }
    return null;
  }

  private async queryDate(flightNumber: string, date: string, apiKey: string): Promise<DateQueryResult> {
    // dateLocalRole=Departure -- our date is (an approximation of) the
    // departure-side calendar date, not the arrival side.
    const url = `${AERODATABOX_FLIGHTS_URL}/${encodeURIComponent(flightNumber)}/${date}?dateLocalRole=Departure`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": AERODATABOX_HOST },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn(`[flight-status] request failed for ${flightNumber}:`, err);
      return { ok: false };
    }

    if (!response.ok) {
      console.warn(`[flight-status] AeroDataBox returned HTTP ${response.status} for ${flightNumber}.`);
      return { ok: false };
    }

    // Multiple entries can come back for a shared flight number across
    // codeshares/aircraft swaps -- the first is AeroDataBox's primary record.
    const flights = (await response.json()) as AeroDataBoxFlight[];
    return { ok: true, flights: flights ?? [] };
  }
}

/**
 * What a page should actually use: AeroDataBox when AERODATABOX_API_KEY is
 * configured, Noop (no network) when it isn't -- the same "unset key means
 * this quietly does nothing" degrade every other optional integration in
 * this app follows (see .env.example). Deliberately not conflicts-for.ts's
 * own default, which stays NoopFlightStatusProvider so its test suite
 * never depends on whatever happens to be set in the environment it runs
 * in -- a page that wants live data asks for it explicitly by calling this.
 */
export function defaultFlightStatusProvider(): FlightStatusProvider {
  return process.env.AERODATABOX_API_KEY
    ? new AeroDataBoxFlightStatusProvider()
    : new NoopFlightStatusProvider();
}
