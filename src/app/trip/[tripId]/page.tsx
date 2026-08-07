import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, listItems, requireTripAccess, type Item } from "@/lib/scope.ts";
import { PHASE_LABEL } from "@/lib/phase.ts";
import { conflictsForViewer } from "@/lib/conflicts-for.ts";
import { flagged } from "@/lib/conflicts.ts";
import { dietaryWarningsForViewer } from "@/lib/dietary-conflicts-for.ts";
import { createInviteAction } from "./actions.ts";
import { absoluteOrigin } from "@/lib/url.ts";
import AddItemForm from "./AddItemForm.tsx";
import DaysSection from "./DaysSection.tsx";
import { ItemList } from "./itemDisplay.tsx";
import { formatTripDateRange } from "@/lib/time.ts";
import { DIETARY_TAG_LABEL } from "@/lib/dietary.ts";
import { listDays, waypointsForDays } from "@/lib/days.ts";

/** Groups items by dayId, each day's list sorted by its manual/chronological draft order. Items with no dayId are dropped -- callers that want those want listItems' own status filters instead. */
function groupByDay(items: Item[]): Map<string, Item[]> {
  const grouped = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.dayId) continue;
    const list = grouped.get(item.dayId) ?? [];
    list.push(item);
    grouped.set(item.dayId, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => (a.dayPosition ?? 0) - (b.dayPosition ?? 0));
  }
  return grouped;
}

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ tripId: string }>;
  searchParams: Promise<{ error?: string; invite?: string }>;
}) {
  const user = await getCurrentUser();
  const { tripId } = await params;
  if (!user) redirect(`/login?next=/trip/${tripId}`);

  let access;
  try {
    access = await requireTripAccess(tripId, user);
  } catch (err) {
    if (err instanceof AccessError) redirect("/trips");
    throw err;
  }

  const { error, invite } = await searchParams;
  const items = await listItems(access);
  const locked = items.filter((i) => i.status === "locked" && i.startsAt);
  // A day-linked item lives inside its day's own card now (see DaysSection
  // below), whatever its status -- there's no separate cross-day "Proposed"
  // list anymore. Ideas keeps its old job of holding ungrounded items, plus
  // a safety net: anything that somehow got a time but no day (its date
  // fell outside the trip's own span) still shows up *somewhere* rather
  // than becoming invisible.
  const ideas = items.filter((i) => !i.dayId && i.status !== "declined");
  const declined = items.filter((i) => i.status === "declined");
  const itemsByDay = groupByDay(items.filter((i) => i.status !== "declined"));
  const findings = flagged(await conflictsForViewer(access));
  const dietaryFindings = await dietaryWarningsForViewer(access);

  const days = await listDays(access);
  const waypointsByDay = await waypointsForDays(days.map((d) => d.id));

  const origin = await absoluteOrigin();

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-xl font-semibold">{access.trip.name}</h1>
          <span className="badge bg-stone-100 text-stone-700">{PHASE_LABEL[access.phase]}</span>
          {access.isPlanner && <span className="badge bg-amber-100 text-amber-800">Planner</span>}
        </div>
        <p className="text-sm text-stone-500">
          {access.trip.destination} · {formatTripDateRange(access.trip.startDate, access.trip.endDate)}
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {invite && (
        <div className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Share this link: <code className="break-all">{origin}/invite/{invite}</code>
        </div>
      )}

      {findings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="mb-2 text-sm font-medium text-amber-900">
            Your schedule has {findings.length} tight or conflicting {findings.length === 1 ? "spot" : "spots"}
          </p>
          <ul className="space-y-1 text-sm text-amber-800">
            {findings.map((f, i) => (
              <li key={i}>
                {f.severity === "conflict" ? "Conflict" : "Tight"}: <strong>{f.before.title}</strong> →{" "}
                <strong>{f.after.title}</strong> —{" "}
                {f.reason === "overlap"
                  ? "these overlap in time."
                  : `${Math.round(f.gapMinutes)} min gap, ~${f.travelMinutes} min travel + ${f.overheadMinutes} min overhead.`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dietaryFindings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="mb-2 text-sm font-medium text-amber-900">
            {dietaryFindings.length} dietary {dietaryFindings.length === 1 ? "mismatch" : "mismatches"} on the
            itinerary
          </p>
          <ul className="space-y-1 text-sm text-amber-800">
            {dietaryFindings.map((f, i) => (
              <li key={i}>
                <strong>{f.itemTitle}</strong> may not work for{" "}
                <strong>{f.member.name ?? f.member.email}</strong> —{" "}
                {f.unmetTags.map((t) => DIETARY_TAG_LABEL[t]).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Days" subtitle="Click a day for its draft itinerary — the pencil edits wake/sleep and stops">
        <DaysSection
          tripId={tripId}
          days={days}
          waypointsByDay={waypointsByDay}
          itemsByDay={itemsByDay}
          timezone={access.trip.timezone}
          destination={access.trip.destination}
          members={access.members}
        />
      </Section>

      <Section title="Itinerary" subtitle="Locked items, in order">
        {locked.length === 0 ? (
          <Empty text="Nothing locked yet." />
        ) : (
          <ItemList tripId={tripId} items={locked} timezone={access.trip.timezone} />
        )}
      </Section>

      <Section title="Ideas" subtitle="Not on a day yet — pin things here and drop them into a day when ready">
        {ideas.length === 0 ? (
          <Empty text="No ideas yet." />
        ) : (
          <ItemList tripId={tripId} items={ideas} timezone={access.trip.timezone} />
        )}
      </Section>

      {declined.length > 0 && (
        <Section title="Declined" subtitle="Restorable">
          <ItemList tripId={tripId} items={declined} timezone={access.trip.timezone} />
        </Section>
      )}

      <Section title="Add something">
        <AddItemForm tripId={tripId} destination={access.trip.destination} members={access.members} />
      </Section>

      <Section title="People">
        <ul className="mb-3 divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
          {access.members.map((m) => (
            <li key={m.userId} className="px-4 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span>{m.name ?? m.email}</span>
                {m.role === "master_planner" && (
                  <span className="badge bg-amber-100 text-amber-800">Planner</span>
                )}
              </div>
              {(m.dietaryRestrictions?.length || m.dietaryNotes) && (
                <p className="mt-0.5 text-xs text-stone-500">
                  🌱{" "}
                  {[
                    ...(m.dietaryRestrictions ?? []).map((tag) => DIETARY_TAG_LABEL[tag]),
                    m.dietaryNotes,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
        {access.isPlanner && (
          <form
            action={createInviteAction.bind(null, tripId)}
            className="flex gap-2"
          >
            <input
              name="email"
              type="email"
              placeholder="Invite by email (optional)"
              className="input"
            />
            <button type="submit" className="btn-secondary shrink-0">
              Create invite link
            </button>
          </form>
        )}
      </Section>
    </div>
  );

  function Section({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
  }) {
    return (
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
        {subtitle && <p className="mb-2 text-xs text-stone-400">{subtitle}</p>}
        {!subtitle && <div className="mb-2" />}
        {children}
      </section>
    );
  }

  function Empty({ text }: { text: string }) {
    return <p className="text-sm text-stone-400">{text}</p>;
  }
}
