import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, listItems, requireTripAccess, type Item } from "@/lib/scope.ts";
import { PHASE_LABEL } from "@/lib/phase.ts";
import { conflictsForViewer } from "@/lib/conflicts-for.ts";
import { defaultFlightStatusProvider } from "@/lib/flight-status.ts";
import { flagged } from "@/lib/conflicts.ts";
import { dietaryWarningsForViewer } from "@/lib/dietary-conflicts-for.ts";
import { createInviteAction, shareItemAction } from "./actions.ts";
import { absoluteOrigin } from "@/lib/url.ts";
import AddItemForm from "./AddItemForm.tsx";
import AgreedDaysSection from "./AgreedDaysSection.tsx";
import PlaySpaceDaysSection from "./PlaySpaceDaysSection.tsx";
import { ItemList, ItemRow } from "./itemDisplay.tsx";
import { formatTripDateRange } from "@/lib/time.ts";
import { DIETARY_TAG_LABEL } from "@/lib/dietary.ts";
import { listDays, locationMembersForLocations, locationsForDays } from "@/lib/days.ts";

type Tab = "agreed" | "playspace" | "scratchpad";
const TABS: { id: Tab; label: string }[] = [
  { id: "agreed", label: "Agreed" },
  { id: "playspace", label: "PlaySpace" },
  { id: "scratchpad", label: "Scratchpad" },
];

/** Groups items by dayId, each day's list sorted by its manual/chronological draft order. Items with no dayId are dropped -- callers that want those filter separately (see the dayless "Ideas" lists below). */
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
  searchParams: Promise<{ error?: string; invite?: string; tab?: string }>;
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

  const { error, invite, tab } = await searchParams;
  // Plain searchParams-driven tabs, not client state -- linkable/bookmarkable
  // for free, no JS needed. An unrecognized or missing value just falls
  // back to Agreed rather than erroring.
  const activeTab: Tab = tab === "playspace" || tab === "scratchpad" ? tab : "agreed";

  const items = await listItems(access);
  // listItems is already scoped (see scope.ts's visibleToViewer) so any
  // "private" row here can only be one the viewer themselves authored --
  // a private item belonging to anyone else was never in this array to
  // begin with. That's what makes a plain visibility filter enough to mean
  // "my Scratchpad," with no separate createdBy check needed.
  const scratchpad = items.filter((i) => i.visibility === "private" && i.status !== "declined");
  const scratchpadDeclined = items.filter((i) => i.visibility === "private" && i.status === "declined");

  const shared = items.filter((i) => i.visibility === "group");
  const locked = shared.filter((i) => i.status === "locked" && i.startsAt);
  const lockedByDay = groupByDay(locked);
  // Same safety net as the old Ideas list had: a locked item's date can, in
  // principle, fall outside the trip's own span (placeInDay never grounded
  // it to a day), and it shouldn't just vanish because of that.
  const lockedOffCalendar = locked.filter((i) => !i.dayId);

  // idea/proposed/locked -- everything shared and still live. Locked items
  // are deliberately included here too (flagged via their own "locked"
  // status badge), so a new proposal's conflicts against what's already
  // agreed are visible in PlaySpace, not just in Agreed.
  const inPlay = shared.filter((i) => i.status !== "declined");
  const inPlayByDay = groupByDay(inPlay);
  const playspaceIdeas = inPlay.filter((i) => !i.dayId);
  const playspaceDeclined = shared.filter((i) => i.status === "declined");

  // undefined keeps conflictsForViewer's own travel-time default (Haversine)
  // -- only the flight-status provider needs picking here.
  const findings = flagged(await conflictsForViewer(access, undefined, defaultFlightStatusProvider()));
  const dietaryFindings = await dietaryWarningsForViewer(access);

  const days = await listDays(access);
  const locationsByDay = await locationsForDays(days.map((d) => d.id));
  const allLocationIds = [...locationsByDay.values()].flat().map((l) => l.id);
  const locationMembers = await locationMembersForLocations(allLocationIds);

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

      <nav className="flex gap-1 border-b border-stone-200">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`?tab=${t.id}`}
            aria-current={activeTab === t.id ? "page" : undefined}
            className={
              activeTab === t.id
                ? "border-b-2 border-stone-800 px-3 py-2 text-sm font-medium text-stone-900"
                : "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-stone-500 hover:text-stone-700"
            }
          >
            {t.label}
          </a>
        ))}
      </nav>

      {activeTab === "agreed" && (
        <div className="space-y-6">
          <p className="text-xs text-stone-400">
            The settled plan — locked items, day by day. Head to PlaySpace to propose something new.
          </p>
          <AgreedDaysSection
            tripId={tripId}
            days={days}
            locationsByDay={locationsByDay}
            locationMembers={locationMembers}
            itemsByDay={lockedByDay}
            timezone={access.trip.timezone}
            members={access.members}
            viewerId={access.viewer.id}
          />
          {lockedOffCalendar.length > 0 && (
            <Section title="Locked, off the calendar" subtitle="Its date falls outside the trip's own span">
              <ItemList tripId={tripId} items={lockedOffCalendar} timezone={access.trip.timezone} />
            </Section>
          )}
        </div>
      )}

      {activeTab === "playspace" && (
        <div className="space-y-6">
          <p className="text-xs text-stone-400">
            Everything shared with the group, overlapping in time — plus whatever&apos;s already locked (flagged
            below) so you can see conflicts before locking something new. The Planner locks the winner, which
            moves it to Agreed.
          </p>
          <PlaySpaceDaysSection
            tripId={tripId}
            days={days}
            itemsByDay={inPlayByDay}
            timezone={access.trip.timezone}
            destination={access.trip.destination}
            members={access.members}
          />

          <Section title="Ideas" subtitle="Shared, but not on a day yet">
            {playspaceIdeas.length === 0 ? (
              <Empty text="No ideas yet." />
            ) : (
              <ItemList tripId={tripId} items={playspaceIdeas} timezone={access.trip.timezone} />
            )}
          </Section>

          {playspaceDeclined.length > 0 && (
            <Section title="Declined" subtitle="Restorable">
              <ItemList tripId={tripId} items={playspaceDeclined} timezone={access.trip.timezone} />
            </Section>
          )}

          <Section title="Add an idea to share">
            <AddItemForm
              tripId={tripId}
              destination={access.trip.destination}
              members={access.members}
              visibility="group"
            />
          </Section>
        </div>
      )}

      {activeTab === "scratchpad" && (
        <div className="space-y-6">
          <p className="text-xs text-stone-400">Yours alone until you share it — nobody else on the trip can see these.</p>

          <Section title="My ideas">
            {scratchpad.length === 0 ? (
              <Empty text="Nothing here yet." />
            ) : (
              <ScratchpadList tripId={tripId} items={scratchpad} timezone={access.trip.timezone} />
            )}
          </Section>

          {scratchpadDeclined.length > 0 && (
            <Section title="Declined" subtitle="Restorable">
              <ItemList tripId={tripId} items={scratchpadDeclined} timezone={access.trip.timezone} />
            </Section>
          )}

          <Section title="Add a private idea">
            <AddItemForm
              tripId={tripId}
              destination={access.trip.destination}
              members={access.members}
              visibility="private"
            />
          </Section>
        </div>
      )}

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

  /** Same row as ItemList, plus a "Share to PlaySpace" action -- see items.ts's shareItem. */
  function ScratchpadList({ tripId, items, timezone }: { tripId: string; items: Item[]; timezone: string }) {
    return (
      <ul className="divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <ItemRow tripId={tripId} item={item} timezone={timezone} />
            </div>
            <form action={shareItemAction.bind(null, tripId, item.id)} className="pr-4">
              <button type="submit" className="whitespace-nowrap text-xs text-stone-500 underline hover:text-stone-700">
                Share to PlaySpace
              </button>
            </form>
          </li>
        ))}
      </ul>
    );
  }
}
