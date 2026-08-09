import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, listItems, requireTripAccess, type Item } from "@/lib/scope.ts";
import { PHASE_LABEL } from "@/lib/phase.ts";
import { conflictsForViewer } from "@/lib/conflicts-for.ts";
import { defaultFlightStatusProvider } from "@/lib/flight-status.ts";
import { flagged } from "@/lib/conflicts.ts";
import { attendingItems, rsvpsForItems } from "@/lib/attendance.ts";
import { dietaryWarningsForViewer } from "@/lib/dietary-conflicts-for.ts";
import { getAssistantHistory } from "@/lib/assistant.ts";
import { createInviteAction, shareItemAction, setMemberRoleAction } from "./actions.ts";
import { absoluteOrigin } from "@/lib/url.ts";
import AddItemSheet from "./AddItemSheet.tsx";
import ShareInviteButton from "./ShareInviteButton.tsx";
import AgreedDaysSection from "./AgreedDaysSection.tsx";
import PlaySpaceDaysSection from "./PlaySpaceDaysSection.tsx";
import AssistantChat from "./AssistantChat.tsx";
import { ItemList, ItemRow } from "./itemDisplay.tsx";
import { formatTripDateRange } from "@/lib/time.ts";
import { DIETARY_TAG_LABEL } from "@/lib/dietary.ts";
import { listDays, locationMembersForLocations, locationsForDays } from "@/lib/days.ts";
import { getPassportDetailsForUsers } from "@/lib/passport.ts";

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
  searchParams: Promise<{ error?: string; invite?: string; tab?: string; view?: string }>;
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

  const { error, invite, tab, view } = await searchParams;
  // Plain searchParams-driven tabs, not client state -- linkable/bookmarkable
  // for free, no JS needed. An unrecognized or missing value just falls
  // back to Agreed rather than erroring.
  const activeTab: Tab = tab === "playspace" || tab === "scratchpad" ? tab : "agreed";
  // Same reasoning for the Agreed tab's own itinerary toggle -- "mine" is
  // the default (an item you declined or never RSVP'd to stays out of your
  // own view), "all" shows the whole group's settled plan regardless of
  // your own RSVP.
  const itineraryView: "mine" | "all" = view === "all" ? "all" : "mine";
  // Only fetched for the tab that actually shows it -- no point querying the
  // assistant's own conversation log on every other tab's render.
  const assistantHistory = activeTab === "scratchpad" ? await getAssistantHistory(access) : [];
  // Only the planner ever sees passport info at all (see
  // canViewMemberPassport) -- a participant never pays the decrypt cost for
  // data they can't see anyway.
  const passportByMember = access.isPlanner
    ? await getPassportDetailsForUsers(access.members.map((m) => m.userId))
    : new Map();

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

  const lockedRsvps = await rsvpsForItems(locked.map((i) => i.id));
  const lockedRsvpMap = new Map(lockedRsvps.map((r) => [r.itemId, r.responses]));
  // "My Itinerary" -- required items automatically, optional items only
  // where the viewer said yes. Same rule conflictsForViewer builds its own
  // timeline from (see attendance.ts's attendingItems), so this is exactly
  // what a planner's-eye "View All" hides: whatever you declined or
  // never answered.
  const myLocked = attendingItems(locked, lockedRsvpMap, access.viewer.id);
  const visibleLocked = itineraryView === "all" ? locked : myLocked;

  const lockedByDay = groupByDay(visibleLocked);
  // Same safety net as the old Ideas list had: a locked item's date can, in
  // principle, fall outside the trip's own span (placeInDay never grounded
  // it to a day), and it shouldn't just vanish because of that.
  const lockedOffCalendar = visibleLocked.filter((i) => !i.dayId);

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
        <ShareInviteButton url={`${origin}/invite/${invite}`} tripName={access.trip.name} />
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
              // inline-flex + min-h-11: these are the app's primary navigation
              // and were 38px tall, just under the touch minimum.
              activeTab === t.id
                ? "inline-flex min-h-11 items-center border-b-2 border-stone-800 px-3 text-sm font-medium text-stone-900"
                : "inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-stone-500 hover:text-stone-700"
            }
          >
            {t.label}
          </a>
        ))}
      </nav>

      {activeTab === "agreed" && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-stone-400">
              The settled plan — locked items, day by day. Head to PlaySpace to propose something new.
            </p>
            <div className="flex items-center gap-1 text-xs">
              <a
                href="?tab=agreed&view=mine"
                aria-current={itineraryView === "mine" ? "page" : undefined}
                className={
                  itineraryView === "mine"
                    ? "inline-flex min-h-11 items-center font-medium text-stone-900 underline"
                    : "inline-flex min-h-11 items-center text-stone-500 underline hover:text-stone-700"
                }
              >
                My Itinerary
              </a>
              <span className="text-stone-300">·</span>
              <a
                href="?tab=agreed&view=all"
                aria-current={itineraryView === "all" ? "page" : undefined}
                className={
                  itineraryView === "all"
                    ? "inline-flex min-h-11 items-center font-medium text-stone-900 underline"
                    : "inline-flex min-h-11 items-center text-stone-500 underline hover:text-stone-700"
                }
              >
                View All
              </a>
            </div>
          </div>
          {itineraryView === "all" && (
            <p className="-mt-4 text-xs text-stone-400">
              Showing everyone&apos;s locked plans, including optional items you declined or haven&apos;t
              answered.
            </p>
          )}
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
        <div className="space-y-6 pb-20">
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

          {/* Keyed on the item count so a successful add remounts the sheet
              closed -- see AddItemSheet. */}
          <AddItemSheet
            key={`group-${inPlay.length}`}
            tripId={tripId}
            visibility="group"
            trigger="floating"
            label="Add an idea"
          />
        </div>
      )}

      {activeTab === "scratchpad" && (
        <div className="space-y-6 pb-20">
          <p className="text-xs text-stone-400">Yours alone until you share it — nobody else on the trip can see these.</p>

          <Section title="Trip assistant">
            <AssistantChat tripId={tripId} history={assistantHistory} />
          </Section>

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

          <AddItemSheet
            key={`private-${scratchpad.length}`}
            tripId={tripId}
            visibility="private"
            trigger="floating"
            label="Add a private idea"
          />
        </div>
      )}

      <Section title="People">
        <ul className="mb-3 divide-y divide-stone-200 rounded-md border border-stone-200 bg-white">
          {access.members.map((m) => (
            <li key={m.userId} className="px-4 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>{m.name ?? m.email}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {m.role === "master_planner" && (
                    <span className="badge bg-amber-100 text-amber-800">Planner</span>
                  )}
                  {m.role === "co_planner" && (
                    <span className="badge bg-amber-50 text-amber-700">Co-planner</span>
                  )}
                  {access.isPlanner && m.userId !== access.viewer.id && m.role !== "master_planner" && (
                    <form
                      action={setMemberRoleAction.bind(
                        null,
                        tripId,
                        m.userId,
                        m.role === "co_planner" ? "participant" : "co_planner",
                      )}
                    >
                      <button type="submit" className="text-xs text-stone-400 underline hover:text-stone-700">
                        {m.role === "co_planner" ? "Revoke" : "Make co-planner"}
                      </button>
                    </form>
                  )}
                </div>
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
              {access.isPlanner &&
                passportByMember.has(m.userId) &&
                (() => {
                  const p = passportByMember.get(m.userId)!;
                  const bits = [
                    p.fullName,
                    p.passportNumber && `#${p.passportNumber}`,
                    p.nationality,
                    p.dateOfBirth && `DOB ${p.dateOfBirth}`,
                    p.expiryDate && `expires ${p.expiryDate}`,
                  ].filter(Boolean);
                  return (
                    <p className="mt-0.5 text-xs text-stone-500">
                      🛂 {bits.join(" · ")}
                      {p.hasPhoto && (
                        <>
                          {" · "}
                          <a
                            href={`/api/trip/${tripId}/members/${m.userId}/passport-photo`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-teal-700 underline"
                          >
                            view photo
                          </a>
                        </>
                      )}
                    </p>
                  );
                })()}
            </li>
          ))}
        </ul>
        {access.isPlanner && (
          <form
            action={createInviteAction.bind(null, tripId)}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <input
              name="email"
              type="email"
              placeholder="Invite by email (optional)"
              className="input"
            />
            <button type="submit" className="btn-secondary sm:shrink-0">
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
