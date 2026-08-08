"use client";

import { useState } from "react";
import type { Item, TripMemberSummary } from "@/lib/scope.ts";
import AddItemForm from "./AddItemForm.tsx";
import { ItemRow } from "./itemDisplay.tsx";

/**
 * A day's own draft, as seen from PlaySpace: its group-visible items in
 * order, an always-visible "+ Add" below the last one (or the only one, on
 * an empty day), and a hover-reveal "+ Add" in the gap between any two
 * items -- same trigger, different discoverability, since inserting
 * mid-list is the less common move. Clicking either expands the full
 * AddItemForm right at that slot, bound to this day and (for a
 * between-items insert) the item it goes after; a time given there still
 * wins over that manual slot once it's set (see items.ts's placeInDay).
 * Every add here is visibility="group" -- PlaySpace is the shared
 * workspace, so there's no private option to offer (that's Scratchpad's
 * job). Agreed's day cards don't use this at all: they're a read-only
 * record of what's locked, not a place to propose new things.
 *
 * `openAt` is either the id of the item a gap sits right after, or the
 * sentinel "end" for the always-visible slot below the last item (or the
 * only slot, on an empty day) -- both omit afterItemId when submitting,
 * since "insert after the last item" and "just append" compute the same
 * position anyway (see items.ts's computeDayPosition).
 */
export default function DayItemBuilder({
  tripId,
  dayId,
  items,
  timezone,
  destination,
  members,
}: {
  tripId: string;
  dayId: string;
  items: Item[];
  timezone: string;
  destination: string;
  members: TripMemberSummary[];
}) {
  const [openAt, setOpenAt] = useState<string | "end" | undefined>(undefined);
  const close = () => setOpenAt(undefined);

  return (
    <div>
      {items.length > 0 && (
        <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
          {items.map((item, i) => (
            <li key={item.id}>
              <ItemRow tripId={tripId} item={item} timezone={timezone} />
              {i < items.length - 1 && (
                <Gap isOpen={openAt === item.id} onOpen={() => setOpenAt(item.id)}>
                  {openAt === item.id && (
                    <AddItemForm
                      tripId={tripId}
                      destination={destination}
                      members={members}
                      visibility="group"
                      dayId={dayId}
                      afterItemId={item.id}
                      onCancel={close}
                    />
                  )}
                </Gap>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        {openAt === "end" ? (
          <AddItemForm
            tripId={tripId}
            destination={destination}
            members={members}
            visibility="group"
            dayId={dayId}
            onCancel={close}
          />
        ) : (
          <button
            type="button"
            onClick={() => setOpenAt("end")}
            className="text-sm text-stone-400 hover:text-stone-700"
          >
            + Add {items.length === 0 ? "the first thing for this day" : ""}
          </button>
        )}
      </div>
    </div>
  );
}

function Gap({
  isOpen,
  onOpen,
  children,
}: {
  isOpen: boolean;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  if (isOpen) {
    return <div className="border-t border-stone-100 bg-stone-50 p-3">{children}</div>;
  }
  return (
    <div className="group/gap relative -my-1.5 h-3">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Add something here"
        className="absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center opacity-0 transition-opacity group-hover/gap:opacity-100"
      >
        <span className="rounded-full border border-stone-300 bg-white px-2 py-0.5 text-xs text-stone-500 shadow-sm hover:border-stone-500 hover:text-stone-800">
          + Add
        </span>
      </button>
    </div>
  );
}
