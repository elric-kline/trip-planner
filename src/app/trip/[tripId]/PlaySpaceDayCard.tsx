"use client";

import { useState } from "react";
import { formatCalendarDate } from "@/lib/time.ts";
import type { TripDay } from "@/lib/days.ts";
import type { Item } from "@/lib/scope.ts";
import DayItemBuilder from "./DayItemBuilder.tsx";

/** A one-line preview of what's proposed for the day, shown while it's collapsed. */
function itemsSummary(items: Item[]): string {
  if (items.length === 0) return "No proposals yet";
  const shown = items.slice(0, 3).map((i) => i.title);
  const more = items.length - shown.length;
  return `${items.length} item${items.length === 1 ? "" : "s"}: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/**
 * A day's card in the **PlaySpace** tab -- where proposals get compared
 * against each other, and against whatever's already locked (shown here
 * too, flagged via its own "locked" status badge, so a new proposal's
 * conflicts against what's already agreed are visible before it goes
 * anywhere), on the way to eventually being locked and moving to Agreed.
 *
 * Deliberately leaner than Agreed's DayCard: no wake/sleep/stops setup --
 * those are settled facts about the day, edited from Agreed, not proposed
 * here. Just the day's header and its item workspace (DayItemBuilder, which
 * handles adding, inserting between two items, and letting a time override
 * the manual order).
 */
export default function PlaySpaceDayCard({
  tripId,
  day,
  items,
  timezone,
  supportCounts,
}: {
  tripId: string;
  day: TripDay;
  /** Every non-declined, non-private item for this day: idea, proposed, AND locked. */
  items: Item[];
  timezone: string;
  supportCounts?: Map<string, number>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
      >
        <h3 className="text-sm font-semibold text-stone-700">
          <span className="mr-1 inline-block w-3 text-stone-400">{open ? "▾" : "▸"}</span>
          {formatCalendarDate(day.date)}
        </h3>
        {/* Collapsed only -- see DayCard. PlaySpace keeps its status badges,
            though: idea / proposed / locked genuinely differ here. */}
        {!open && <span className="text-right text-sm text-stone-500">{itemsSummary(items)}</span>}
      </button>

      {open && (
        <div className="mt-4 border-t border-stone-100 pt-4">
          {/* Keyed on the item count so a successful add remounts the builder
              fresh, which closes whichever add sheet was open -- see
              AddItemSheet for why that's the close mechanism. */}
          <DayItemBuilder
            key={items.length}
            tripId={tripId}
            dayId={day.id}
            items={items}
            timezone={timezone}
            supportCounts={supportCounts}
          />
        </div>
      )}
    </div>
  );
}
