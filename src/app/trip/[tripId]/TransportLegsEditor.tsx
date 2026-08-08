"use client";

import { useState } from "react";
import { utcToZonedInputValue } from "@/lib/time.ts";
import type { TransportLeg } from "@/lib/transport.ts";

type LegRow = {
  key: number;
  airline: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departsAt: string;
  arrivesAt: string;
};

function emptyRow(key: number): LegRow {
  return {
    key,
    airline: "",
    flightNumber: "",
    departureAirport: "",
    arrivalAirport: "",
    departsAt: "",
    arrivesAt: "",
  };
}

/**
 * A flight's legs, one row per connection, in the order flown. Field names
 * repeat across rows (e.g. every row has its own `name="airline"` input) --
 * the server action collects each with formData.getAll, same technique as
 * DiningEditForm's repeated `accommodates` checkboxes, relying on the same
 * document order the rows render in.
 *
 * Rows are uncontrolled (defaultValue) apart from the list itself: adding
 * or removing a row only needs to know which rows exist, not track every
 * keystroke in React state.
 */
export default function TransportLegsEditor({
  action,
  legs,
  timeZone,
}: {
  action: (formData: FormData) => void;
  legs: TransportLeg[];
  timeZone: string;
}) {
  const initialRows: LegRow[] =
    legs.length > 0
      ? legs.map((leg, i) => ({
          key: i,
          airline: leg.airline ?? "",
          flightNumber: leg.flightNumber ?? "",
          departureAirport: leg.departureAirport ?? "",
          arrivalAirport: leg.arrivalAirport ?? "",
          departsAt: utcToZonedInputValue(leg.departsAt, timeZone),
          arrivesAt: utcToZonedInputValue(leg.arrivesAt, timeZone),
        }))
      : [emptyRow(0)];

  const [rows, setRows] = useState<LegRow[]>(initialRows);
  const [nextKey, setNextKey] = useState(initialRows.length);

  return (
    <form action={action} className="grid gap-3">
      <p className="text-xs text-stone-400">
        One row per leg, in the order flown — a nonstop flight is just one row. Saving resyncs this item&apos;s
        own start/end to the first departure and last arrival.
      </p>
      {rows.map((row, i) => (
        <div key={row.key} className="grid gap-2 rounded-md border border-stone-100 bg-white p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-stone-500">Leg {i + 1}</p>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                className="text-xs text-red-600 underline"
              >
                Remove
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input name="airline" defaultValue={row.airline} placeholder="Airline" className="input" />
            <input
              name="flightNumber"
              defaultValue={row.flightNumber}
              placeholder="Flight # (e.g. UA123)"
              className="input"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              name="departureAirport"
              defaultValue={row.departureAirport}
              placeholder="From (e.g. SFO)"
              className="input"
            />
            <input
              name="arrivalAirport"
              defaultValue={row.arrivalAirport}
              placeholder="To (e.g. JFK)"
              className="input"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-stone-700">Departs</span>
              <input type="datetime-local" name="departsAt" defaultValue={row.departsAt} required className="input" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-stone-700">Arrives</span>
              <input type="datetime-local" name="arrivesAt" defaultValue={row.arrivesAt} required className="input" />
            </label>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          setRows((prev) => [...prev, emptyRow(nextKey)]);
          setNextKey((k) => k + 1);
        }}
        className="justify-self-start text-sm text-stone-500 underline"
      >
        + Add another leg
      </button>
      <button className="btn-secondary justify-self-start">Save flight legs</button>
    </form>
  );
}
