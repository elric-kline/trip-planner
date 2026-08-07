"use client";

import { useState, type RefObject } from "react";
import type { DietaryTag } from "@/lib/dietary.ts";

export type CuisineResult = {
  cuisine: string | null;
  accommodates: DietaryTag[];
  summary: string | null;
};

/**
 * Tier 2 of the dining-prefill flow: Places (RestaurantSearch) gives us
 * name/address/phone/price honestly; cuisine framing and dietary
 * accommodations need an actual web-read, which is what /api/dining/infer
 * (cuisine-inference.ts) does with a Claude web-search call. A button, not
 * an automatic lookup on every keystroke — it burns a real LLM + web-search
 * call per click, and same as every other AI/external prefill in this app,
 * the result is a starting point a human still has to confirm before
 * saving, never an auto-fill that skips review.
 *
 * Reads the restaurant name from a ref rather than tracking it in state:
 * the title field it points at is an uncontrolled, key-remounted input (see
 * AddItemForm's DiningPrefill trick), and this avoids converting it to a
 * fully controlled field just to read it once, on click.
 */
export default function CuisineLookupButton({
  nameRef,
  address,
  disabled,
  onResult,
}: {
  nameRef: RefObject<HTMLInputElement | null>;
  address: string | null;
  disabled?: boolean;
  onResult: (result: CuisineResult) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  async function lookup() {
    const name = nameRef.current?.value.trim();
    if (!name) {
      setError(true);
      return;
    }
    setLoading(true);
    setError(false);
    setSummary(null);
    try {
      const res = await fetch("/api/dining/infer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, address }),
      });
      const data = (await res.json()) as { result?: CuisineResult | null };
      if (!res.ok || !data.result) {
        setError(true);
        return;
      }
      setSummary(data.result.summary);
      onResult(data.result);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={lookup}
        disabled={disabled || loading}
        className="btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Looking up…" : "🔍 Look up cuisine & dietary info"}
      </button>
      {error && (
        <p className="mt-1 text-xs text-red-600">
          {nameRef.current?.value.trim()
            ? "Couldn't find reliable info for that one — fill the fields in below instead."
            : "Enter a restaurant name first."}
        </p>
      )}
      {summary && !error && (
        <p className="mt-1 text-xs text-stone-500">AI-suggested, please verify — {summary}</p>
      )}
    </div>
  );
}
