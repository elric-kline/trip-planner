"use client";

import { useEffect, useRef, useState } from "react";

type Suggestion = { description: string; placeId: string };
export type PlaceDetails = {
  name: string | null;
  formattedAddress: string | null;
  phone: string | null;
  website: string | null;
  priceLevel: number | null;
};

/**
 * "Which restaurant did they mean" — search biased to the trip's
 * destination, confirm a match, then pull real details (address, phone,
 * website, price) from Google's Place Details for the caller to prefill a
 * form with. Deliberately does NOT touch cuisine or dietary accommodations
 * — Places' own data there is too coarse to trust silently; that's the
 * separate LLM web-read step. This is a standalone picker, not a form field
 * itself (no `name` prop) — the parent owns what actually gets submitted.
 */
export default function RestaurantSearch({
  destination,
  onConfirm,
}: {
  destination: string;
  onConfirm: (details: PlaceDetails, placeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [matched, setMatched] = useState<{ description: string } | null>(null);
  const [error, setError] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setQuery(next);
    setError(false);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (next.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const thisRequestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ input: next, destination });
        const res = await fetch(`/api/places/search-restaurant?${params}`);
        if (thisRequestId !== requestIdRef.current) return; // a newer keystroke already superseded this
        if (!res.ok) return;
        const data = (await res.json()) as { suggestions?: Suggestion[] };
        const results = data.suggestions ?? [];
        setSuggestions(results);
        setOpen(results.length > 0);
      } catch {
        // Suggestions are a nicety, not a requirement -- typing still works.
      }
    }, 300);
  }

  async function select(s: Suggestion) {
    setSuggestions([]);
    setOpen(false);
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/places/details?placeId=${encodeURIComponent(s.placeId)}`);
      const data = (await res.json()) as { details?: PlaceDetails | null };
      if (!res.ok || !data.details) {
        setError(true);
        return;
      }
      setMatched({ description: s.description });
      onConfirm(data.details, s.placeId);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function searchAgain() {
    setMatched(null);
    setQuery("");
    setError(false);
  }

  if (matched) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
        <span className="text-emerald-800">✓ Matched: {matched.description}</span>
        <button type="button" onClick={searchAgain} className="shrink-0 text-emerald-700 underline">
          Search again
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        value={query}
        onChange={onChange}
        onFocus={() => setOpen(suggestions.length > 0)}
        placeholder="Search for the restaurant by name…"
        className="input"
        autoComplete="off"
        disabled={loading}
      />
      {loading && <p className="mt-1 text-xs text-stone-400">Looking up details…</p>}
      {error && (
        <p className="mt-1 text-xs text-red-600">
          Couldn't fetch details for that one — try another result, or just fill the fields in below.
        </p>
      )}
      {open && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-stone-200 bg-white shadow-md">
          {suggestions.map((s) => (
            <li key={s.placeId}>
              <button
                type="button"
                onClick={() => select(s)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-stone-50"
              >
                {s.description}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
