import type { Item } from "@/lib/scope.ts";

/**
 * The item row markup shared between the trip page's own sections
 * (Itinerary, Ideas, Declined) and each day's item builder (DayItemBuilder)
 * -- one look for "here's an item" everywhere it shows up.
 */

export function formatItemTime(item: Item, timezone: string): string {
  if (!item.startsAt) return "";
  const tz = item.timezone ?? timezone;
  const start = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(item.startsAt);
  if (!item.endsAt) return start;
  const end = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(item.endsAt);
  return `${start} – ${end}`;
}

export const STATUS_BADGE: Record<Item["status"], string> = {
  idea: "bg-stone-100 text-stone-600",
  proposed: "bg-blue-100 text-blue-800",
  locked: "bg-emerald-100 text-emerald-800",
  declined: "bg-red-100 text-red-700 line-through",
};

export function ItemRow({
  tripId,
  item,
  timezone,
  hideStatus = false,
  supportCount,
}: {
  tripId: string;
  item: Item;
  timezone: string;
  /**
   * Drops the status badge. Set inside the Agreed tab, where every row is
   * locked by definition -- an emerald "locked" pill on each one is three
   * identical badges telling you what the tab already said.
   */
  hideStatus?: boolean;
  /**
   * How many people have said "I'm in". Shown in PlaySpace, where the whole
   * question is which of several options the group actually wants -- a planner
   * comparing three Saturday ideas needs that on the row, not one tap deeper.
   * Omitted in Agreed, where the decision has already been made.
   */
  supportCount?: number;
}) {
  return (
    <a
      href={`/trip/${tripId}/items/${item.id}`}
      className="flex items-center justify-between px-4 py-3 hover:bg-stone-50"
    >
      <div>
        <div className="font-medium">
          {item.title}
          {item.visibility === "private" && (
            <span className="badge ml-2 bg-purple-100 text-purple-700">Private</span>
          )}
        </div>
        <div className="text-sm text-stone-500">
          {item.startsAt ? formatItemTime(item, timezone) : "No time yet"}
          {item.locationName ? ` · ${item.locationName}` : ""}
          {/* On the detail line rather than as a right-hand badge: at 390px the
              badge column already carries status, and a second pill there wraps
              to two lines mid-row. */}
          {supportCount != null && supportCount > 0 && (
            <span className="whitespace-nowrap font-medium text-emerald-700"> · {supportCount} in</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {item.commitment && <span className="badge bg-stone-100 text-stone-700">{item.commitment}</span>}
        {!hideStatus && <span className={`badge ${STATUS_BADGE[item.status]}`}>{item.status}</span>}
      </div>
    </a>
  );
}

export function ItemList({
  tripId,
  items,
  timezone,
  hideStatus = false,
  supportCounts,
}: {
  tripId: string;
  items: Item[];
  timezone: string;
  hideStatus?: boolean;
  supportCounts?: Map<string, number>;
}) {
  return (
    <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
      {items.map((item) => (
        <li key={item.id}>
          <ItemRow
            tripId={tripId}
            item={item}
            timezone={timezone}
            hideStatus={hideStatus}
            supportCount={supportCounts?.get(item.id)}
          />
        </li>
      ))}
    </ul>
  );
}
