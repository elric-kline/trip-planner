export type TripPhase = "planning" | "active" | "completed";

type PhaseInput = {
  startDate: string; // YYYY-MM-DD in the destination's local reckoning
  endDate: string;
  timezone: string;
  phaseOverride?: TripPhase | null;
};

/**
 * Phase follows the calendar, with a manual override for the cases the
 * calendar gets wrong — locking early, or a trip that ran long.
 *
 * Comparison happens in the destination's zone: it is still the trip's last
 * day in Lisbon when it is already tomorrow for a member back home.
 */
export function derivePhase(trip: PhaseInput, now: Date = new Date()): TripPhase {
  if (trip.phaseOverride) return trip.phaseOverride;

  const today = localDate(now, trip.timezone);
  if (today < trip.startDate) return "planning";
  if (today > trip.endDate) return "completed";
  return "active";
}

/** YYYY-MM-DD for an instant as seen in the given IANA zone. */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which sorts lexicographically.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export const PHASE_LABEL: Record<TripPhase, string> = {
  planning: "Planning",
  active: "Active",
  completed: "Memory book",
};
