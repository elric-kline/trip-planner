"use client";

import { useState } from "react";
import Sheet from "./Sheet.tsx";

/**
 * The trip's roster, reachable from the header instead of sitting under every
 * tab.
 *
 * "People" used to render outside the tab switch, so the same list -- plus the
 * invite form, and for a planner everyone's dietary notes and passport details
 * -- appeared below Agreed, PlaySpace *and* Scratchpad. Three renders of the
 * same block, always at the very bottom, which on a phone meant scrolling past
 * the whole trip to find out who was on it.
 *
 * The roster is a fact about the trip, not about the tab you happen to be
 * looking at, so it belongs beside the trip's own name. The summary line is
 * the affordance; the sheet holds the full list, since roles, dietary needs
 * and passport records are far too much to keep permanently on screen (and,
 * in the passport case, too sensitive to leave sitting open).
 *
 * `children` is server-rendered and passed through this client boundary
 * intact, which is what lets the list keep using server actions for invites
 * and role changes without any of it becoming client state.
 */
export default function PeopleSheet({
  names,
  children,
}: {
  names: string[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const summary = `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 max-w-full items-center gap-2 text-left text-sm text-stone-500 hover:text-stone-800"
      >
        <span aria-hidden="true">👥</span>
        <span className="truncate underline">
          {names.length} {names.length === 1 ? "person" : "people"} · {summary}
        </span>
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="People"
        description="Everyone on this trip, and how to add more."
      >
        {children}
      </Sheet>
    </>
  );
}
