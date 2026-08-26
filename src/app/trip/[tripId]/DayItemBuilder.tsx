"use client";

import type { Item } from "@/lib/scope.ts";
import type { TimedInterval } from "@/lib/suggest-time.ts";
import AddItemSheet from "./AddItemSheet.tsx";
import { ItemRow } from "./itemDisplay.tsx";

/**
 * The day's own locked, timed activities -- what AddItemForm's Starts field
 * guesses a free-looking time from (see suggest-time.ts's suggestStartTime).
 * Lodging is excluded: a multi-day stay doesn't occupy this one day the way
 * an activity does (see conflicts.ts's own treatment of lodging), so
 * counting it here would read as "the whole day's booked" for a day that's
 * actually wide open.
 */
function lockedTimesFor(items: Item[]): TimedInterval[] {
  return items
    .filter((i): i is Item & { startsAt: Date } => i.status === "locked" && i.category !== "lodging" && i.startsAt != null)
    .map((i) => ({ startsAt: i.startsAt, endsAt: i.endsAt }));
}

/**
 * A day's own draft, as seen from PlaySpace: its group-visible items in order,
 * an "+ Add" below the last one, and an insert slot in the gap between any two
 * items. Every add here is visibility="group" -- PlaySpace is the shared
 * workspace, so there's no private option to offer (that's Scratchpad's job).
 * Agreed's day cards don't use this at all: they're a read-only record of
 * what's locked, not a place to propose new things.
 *
 * The gap slots used to be `opacity-0` and revealed on `group-hover`, which
 * meant that on the phone this product is built for, inserting between two
 * items was not merely hard to find -- it was unreachable, since touch has no
 * hover state. They're visible now: quiet enough not to compete with the items
 * themselves, present enough to be tappable.
 *
 * Each slot opens the same sheet the tab-level button does (AddItemSheet),
 * rather than expanding a form in place and pushing the rest of the day down
 * the page. A time entered there still wins over the manual slot once it's set
 * (see items.ts's placeInDay).
 */
export default function DayItemBuilder({
  tripId,
  dayId,
  dayDate,
  items,
  timezone,
  tripStartDate,
  tripEndDate,
  supportCounts,
  conflictedItemIds,
}: {
  tripId: string;
  dayId: string;
  /** This day's own calendar date -- see AddItemForm.tsx's dayDate. */
  dayDate: string;
  items: Item[];
  timezone: string;
  /** The trip's own span -- see AddItemForm.tsx's tripStartDate/tripEndDate. */
  tripStartDate: string;
  tripEndDate: string;
  supportCounts?: Map<string, number>;
  conflictedItemIds?: Set<string>;
}) {
  const lockedTimes = lockedTimesFor(items);

  return (
    <div>
      {items.length > 0 && (
        <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
          {items.map((item, i) => (
            <li key={item.id}>
              <ItemRow
                tripId={tripId}
                item={item}
                timezone={timezone}
                supportCount={supportCounts?.get(item.id)}
                conflicted={conflictedItemIds?.has(item.id)}
              />
              {i < items.length - 1 && (
                <div className="flex justify-center border-t border-dashed border-stone-200">
                  <AddItemSheet
                    tripId={tripId}
                    visibility="group"
                    dayId={dayId}
                    dayDate={dayDate}
                    lockedTimes={lockedTimes}
                    tripStartDate={tripStartDate}
                    tripEndDate={tripEndDate}
                    timezone={timezone}
                    afterItemId={item.id}
                    precedingLocationName={item.locationName}
                    followingLocationName={items[i + 1].locationName}
                    trigger="inline"
                    label="Add here"
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        <AddItemSheet
          tripId={tripId}
          visibility="group"
          dayId={dayId}
          dayDate={dayDate}
          lockedTimes={lockedTimes}
          tripStartDate={tripStartDate}
          tripEndDate={tripEndDate}
          timezone={timezone}
          trigger="row"
          label={items.length === 0 ? "Add the first thing for this day" : "Add"}
        />
      </div>
    </div>
  );
}
