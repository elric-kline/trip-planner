"use client";

import { useEffect, useState } from "react";

/**
 * Destination, plus the timezone it implies.
 *
 * The form used to ask for the zone outright: a required field labelled
 * "Destination timezone (IANA)", prefilled with `America/Mexico_City` whatever
 * the trip was. A consumer trip planner asking people to know IANA identifiers
 * is bad enough; defaulting every trip to Mexico City is worse, because the
 * zone is what every `datetime-local` on the trip gets interpreted against.
 * Get it wrong and the whole itinerary is quietly out by hours, with the
 * conflict engine reasoning about times nobody meant.
 *
 * So it's derived and shown, not asked for. Typing a destination resolves the
 * zone in the background and reports it in words ("Times will show in Central
 * Standard Time"). Wrong is still fixable -- "change" reveals the raw id --
 * but the default is right and, crucially, visible.
 *
 * Three fallbacks, because none of this can be allowed to block making a trip:
 * the lookup's answer, else this browser's own zone, else whatever the server
 * works out on its own (see createTripAction).
 */
export default function DestinationTimezone() {
  const [destination, setDestination] = useState("");
  const [resolved, setResolved] = useState<{ id: string; label: string } | null>(null);
  const [state, setState] = useState<"idle" | "looking" | "failed">("idle");
  const [manual, setManual] = useState(false);
  /*
   * The browser's own zone is the fallback: for the very common "I'm booking a
   * trip from home to somewhere in my own country" case it's usually right,
   * and it's always a better guess than a hardcoded city.
   *
   * Read after mount rather than during render, because the server has no idea
   * what it is -- it would render UTC, the client would render Europe/Lisbon,
   * and React would throw a hydration mismatch. Until it's known, the hidden
   * field stays empty and the server derives the zone from the destination
   * instead (see trips/actions.ts's resolveTimezone), so submitting early
   * still lands somewhere sensible.
   */
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  useEffect(() => {
    const place = destination.trim();
    if (place.length < 3) {
      setResolved(null);
      setState("idle");
      return;
    }

    const controller = new AbortController();
    // Debounced: this is a paid lookup on every keystroke otherwise.
    const timer = setTimeout(async () => {
      setState("looking");
      try {
        const res = await fetch(`/api/timezone?place=${encodeURIComponent(place)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { timezone: string | null; label: string | null };
        if (data.timezone && data.label) {
          setResolved({ id: data.timezone, label: data.label });
          setState("idle");
        } else {
          setResolved(null);
          setState("failed");
        }
      } catch {
        // An aborted request is the normal case here (the next keystroke), so
        // it isn't worth surfacing as a failure.
        if (!controller.signal.aborted) setState("failed");
      }
    }, 600);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [destination]);

  const effective = resolved?.id ?? browserZone ?? "";

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-stone-700">Destination</span>
        <input
          name="destination"
          required
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="Oaxaca, Mexico"
          className="input"
        />
      </label>

      {!manual ? (
        <div className="-mt-2 text-sm text-stone-500">
          <input type="hidden" name="timezone" value={effective} />
          {state === "looking" ? (
            <span>Working out the local time zone…</span>
          ) : resolved ? (
            <span>
              Times will show in <strong className="font-medium text-stone-700">{resolved.label}</strong>.
            </span>
          ) : browserZone ? (
            <span>
              Times will use your own time zone (
              <strong className="font-medium text-stone-700">{browserZone}</strong>)
              {state === "failed" ? " — we couldn't place that destination." : "."}
            </span>
          ) : (
            <span>Times will use the destination&apos;s own time zone.</span>
          )}{" "}
          <button
            type="button"
            onClick={() => setManual(true)}
            className="underline hover:text-stone-800"
          >
            Change
          </button>
        </div>
      ) : (
        <label className="-mt-2 block">
          <span className="mb-1 block text-sm font-medium text-stone-700">Time zone</span>
          <input name="timezone" defaultValue={effective} className="input" />
          <span className="mt-1 block text-sm text-stone-500">
            An IANA identifier, e.g. America/Mexico_City.
          </span>
        </label>
      )}
    </>
  );
}
