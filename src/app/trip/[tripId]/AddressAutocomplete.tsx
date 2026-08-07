"use client";

import { useEffect, useRef, useState } from "react";

type Suggestion = { description: string; placeId: string };

/**
 * A plain text input with a Google Places suggestion dropdown underneath —
 * selecting one just fills in the text. Coordinates still come from
 * geocodeAddress() server-side when the form is submitted (see actions.ts),
 * so this is purely a typing aid: if suggestions never load (no API key,
 * offline, request failed), the field still works exactly like a normal
 * text input.
 */
export default function AddressAutocomplete({
  name,
  defaultValue = "",
  placeholder,
  className,
  restrict,
}: {
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  className?: string;
  /** "place" narrows suggestions to cities/towns/villages (a trip day's wake/sleep/stop fields); omitted keeps the full unrestricted address lookup. */
  restrict?: "place";
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
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
    setValue(next);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (next.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const thisRequestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const restrictParam = restrict ? `&restrict=${restrict}` : "";
        const res = await fetch(`/api/places/autocomplete?input=${encodeURIComponent(next)}${restrictParam}`);
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

  function select(s: Suggestion) {
    setValue(s.description);
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        name={name}
        value={value}
        onChange={onChange}
        onFocus={() => setOpen(suggestions.length > 0)}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
      />
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
