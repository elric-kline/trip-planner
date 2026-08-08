/**
 * Pure, DB-free transport-subtype logic -- same split as lifecycle.ts vs
 * items.ts: the rules live here so they're unit-testable with no database,
 * and lib/transport.ts (which does touch the database) is the only caller.
 *
 * TransportSubtype mirrors db/schema.ts's transportSubtype pgEnum values by
 * hand, same as lifecycle.ts's ItemStatus mirrors itemStatus -- keep the two
 * in sync if either changes.
 */
export type TransportSubtype = "flight" | "train" | "drive" | "rideshare" | "other";

export type TransportBuffer = {
  /** Added before the item's own startsAt -- check-in, security, boarding, waiting for a ride to actually pull up. */
  preMinutes: number;
  /** Added after the item's own endsAt -- bag claim, parking, walking out of the station. */
  postMinutes: number;
};

/**
 * Static, subtype-keyed padding for a transport item itself -- distinct
 * from travel.ts's MODE_OVERHEAD_MIN, which is the walk/drive/transit link
 * *between* two items. This is what a flight, train, drive, or rideshare
 * silently costs beyond its own startsAt/endsAt: a boarding pass doesn't
 * budget the security line, a pickup time doesn't budget the driver
 * actually arriving.
 *
 * All flat and deterministic on purpose -- same "no external dependency,
 * good enough to make the logic testable" reasoning as
 * HaversineTravelTimeProvider (see travel.ts). A live status feed (gate
 * change, actual delay) is a natural fast-follow behind its own provider
 * interface, same shape as TravelTimeProvider; these constants are what it
 * falls back to when unset.
 */
const DOMESTIC_FLIGHT_BUFFER: TransportBuffer = { preMinutes: 90, postMinutes: 30 };
const INTERNATIONAL_FLIGHT_BUFFER: TransportBuffer = { preMinutes: 150, postMinutes: 45 };

const NON_FLIGHT_BUFFER: Record<Exclude<TransportSubtype, "flight">, TransportBuffer> = {
  // A scheduled departure is close enough to reliable that boarding is the only real pad.
  train: { preMinutes: 15, postMinutes: 5 },
  // Getting *to* the car is travel.ts's problem; this is finding a spot once you're there.
  drive: { preMinutes: 0, postMinutes: 10 },
  // Not the ride itself -- the wait for the driver to actually arrive.
  rideshare: { preMinutes: 10, postMinutes: 0 },
  other: { preMinutes: 15, postMinutes: 15 },
};

/** The pre/post padding a transport item needs around its own startsAt/endsAt, keyed by subtype (and, for flights, international). */
export function transportBufferFor(
  subtype: TransportSubtype,
  international?: boolean | null,
): TransportBuffer {
  if (subtype === "flight") {
    return international ? INTERNATIONAL_FLIGHT_BUFFER : DOMESTIC_FLIGHT_BUFFER;
  }
  return NON_FLIGHT_BUFFER[subtype];
}

/**
 * Minimum layover a connection needs before analyzeLegLayovers flags it as
 * tight. A conservative flat default, not real per-airport minimum
 * connection time data -- international connections (customs, immigration,
 * re-screening) get a longer floor.
 */
export const MIN_CONNECTION_MINUTES = 45;
export const MIN_INTERNATIONAL_CONNECTION_MINUTES = 90;

/** The only shape analyzeLegLayovers/deriveScheduleFromLegs actually need -- a real leg row (see transport.ts's TransportLeg) satisfies this structurally, with no dependency the other way. */
export type LegTiming = { departsAt: Date; arrivesAt: Date };

export type LayoverFinding<T extends LegTiming> = {
  beforeLeg: T;
  afterLeg: T;
  layoverMinutes: number;
  minimumMinutes: number;
  tight: boolean;
};

/**
 * Every consecutive leg pair's dwell time, flagged against the minimum
 * connection time. Legs must already be in order -- lib/transport.ts's
 * getTransportLegs returns them that way, and setTransportLegs assigns
 * legOrder from the array order it's given.
 */
export function analyzeLegLayovers<T extends LegTiming>(
  legs: T[],
  international?: boolean | null,
): LayoverFinding<T>[] {
  const minimumMinutes = international
    ? MIN_INTERNATIONAL_CONNECTION_MINUTES
    : MIN_CONNECTION_MINUTES;

  const findings: LayoverFinding<T>[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const beforeLeg = legs[i];
    const afterLeg = legs[i + 1];
    const layoverMinutes = (afterLeg.departsAt.getTime() - beforeLeg.arrivesAt.getTime()) / 60_000;
    findings.push({
      beforeLeg,
      afterLeg,
      layoverMinutes,
      minimumMinutes,
      tight: layoverMinutes < minimumMinutes,
    });
  }
  return findings;
}

/**
 * The item's own startsAt/endsAt for a flight with legs: first leg's
 * departure to last leg's arrival -- same "door-to-door span" reasoning as
 * lodging's check-in/out (see schema.ts's lodgingDetails doc). Legs must be
 * sorted, same requirement as analyzeLegLayovers. Null for an empty list --
 * this module doesn't throw; lib/transport.ts's setTransportLegs is what
 * turns that into a RuleError, since "reject an empty leg list" is a
 * validation policy, not a fact about the legs themselves.
 */
export function deriveScheduleFromLegs<T extends LegTiming>(
  legs: T[],
): { startsAt: Date; endsAt: Date } | null {
  if (legs.length === 0) return null;
  return { startsAt: legs[0].departsAt, endsAt: legs[legs.length - 1].arrivesAt };
}
