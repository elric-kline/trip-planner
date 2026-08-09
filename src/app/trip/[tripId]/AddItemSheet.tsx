"use client";

import { useState } from "react";
import Sheet from "./Sheet.tsx";
import AddItemForm from "./AddItemForm.tsx";

/**
 * The one way to add something, in all three places it can be done: the
 * tab-level button, a day's own "+ Add," and the insert slot between two
 * items. It used to be a permanently expanded form sitting at the bottom of
 * both PlaySpace and Scratchpad -- roughly 40% of the page's height whether or
 * not anyone was adding anything, and below every day card, so on a phone you
 * scrolled past the entire trip to reach the thing that adds to it.
 *
 * Closing after a successful add is deliberately not tracked here. The server
 * action revalidates the trip page, so the caller re-renders with a different
 * item count; keying this component on that count (see DayItemBuilder and the
 * trip page) remounts it closed. It's the same trick the old inline builder
 * used, and it means "did the add succeed?" stays the server's question rather
 * than something the client has to infer.
 */
export default function AddItemSheet({
  tripId,
  visibility,
  dayId,
  afterItemId,
  precedingLocationName,
  followingLocationName,
  trigger,
  label,
}: {
  tripId: string;
  visibility: "private" | "group";
  dayId?: string;
  afterItemId?: string;
  precedingLocationName?: string | null;
  followingLocationName?: string | null;
  /**
   * "floating" is the tab-level button, pinned bottom-right within thumb
   * reach; "row" is a day's end-of-list slot; "inline" is the slim marker
   * between two existing items.
   */
  trigger: "floating" | "row" | "inline";
  label: string;
}) {
  const [open, setOpen] = useState(false);

  const triggerClass =
    trigger === "floating"
      ? "btn-primary fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 shadow-lg"
      : trigger === "row"
        ? "inline-flex min-h-11 items-center text-sm text-stone-500 hover:text-stone-800"
        : "mx-auto inline-flex min-h-11 items-center rounded-full px-3 text-xs text-stone-400 hover:text-stone-700";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerClass}>
        {trigger === "floating" ? `+ ${label}` : `+ ${label}`}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={visibility === "private" ? "Add a private idea" : "Add an idea"}
        description={
          visibility === "private"
            ? "Yours alone until you share it."
            : "Shared with everyone on the trip."
        }
      >
        <AddItemForm
          tripId={tripId}
          visibility={visibility}
          dayId={dayId}
          afterItemId={afterItemId}
          precedingLocationName={precedingLocationName}
          followingLocationName={followingLocationName}
          onCancel={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}
