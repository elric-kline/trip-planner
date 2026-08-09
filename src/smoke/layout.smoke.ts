import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright";
import {
  clickButton,
  newSession,
  signInWithLink,
  startBrowser,
  startServer,
  visit,
  type Server,
  type Session,
} from "./harness.ts";
import { formatViolations, layoutViolations } from "./layout.ts";
import { db } from "@/db";
import { loginTokens, users } from "@/db/schema";
import { addTripMember, cleanupTrip, createTestUser } from "@/lib/test-fixtures.ts";
import { createInvite, createTrip } from "@/lib/trips.ts";
import { requireTripAccess } from "@/lib/scope.ts";
import { createItem, lockItem, scheduleItem } from "@/lib/items.ts";
import { addLocation, listDays } from "@/lib/days.ts";
import type { CurrentUser } from "@/lib/auth.ts";

/**
 * The mobile layout invariants, over every page a person can actually reach.
 *
 * Where flows.smoke.ts asks "did this land in the right place", this asks "is
 * the place it landed usable in a hand". Both run against the same production
 * build in the same browser; see layout.ts for the four rules and the shipped
 * defect behind each one.
 *
 * The route list is the maintenance surface here, and it's meant to be: a page
 * nobody adds to it is a page nobody checks. Everything else is a global rule
 * with no selector to keep in sync.
 */

let server: Server;
let browser: Browser;
const tripCleanups: (() => Promise<void>)[] = [];
const userCleanups: (() => Promise<void>)[] = [];

/** A trip with content: two members, locations, and items in every status. */
type Fixture = {
  planner: CurrentUser;
  member: CurrentUser;
  tripId: string;
  itemId: string;
  lockedItemId: string;
  inviteToken: string;
};
let fx: Fixture;

before(async () => {
  server = await startServer();
  browser = await startBrowser();
  fx = await seedFixture();
});

after(async () => {
  for (const fn of tripCleanups) await fn().catch(() => {});
  for (const fn of userCleanups) await fn().catch(() => {});
  await browser?.close();
  await server?.stop();
});

function trackUser(user: CurrentUser): CurrentUser {
  userCleanups.push(async () => {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(loginTokens).where(eq(loginTokens.email, user.email));
  });
  return user;
}

/**
 * Built through the library rather than the UI. Driving twenty forms to
 * arrange a page would put the fragile part of the harness in the setup,
 * where a failure says "couldn't click Add" instead of naming a layout rule.
 */
async function seedFixture(): Promise<Fixture> {
  // Long enough to push the header's name/sign-out row to its limit -- that
  // pair wrapped to two lines the first time a real name appeared there.
  const planner = trackUser(await createTestUser({ name: "Anastasia Ravensbourne-Whitfield" }));
  const member = trackUser(await createTestUser({ name: "Bernadette Okonkwo-Lindqvist" }));

  const trip = await createTrip(planner, {
    name: "Three weeks around the west coast of Ireland",
    destination: "Galway, Ireland",
    startDate: "2026-06-12",
    endDate: "2026-06-15",
    timezone: "Europe/Dublin",
  });
  tripCleanups.push(() => cleanupTrip(trip.id, []));
  await addTripMember(trip.id, member.id, "participant");

  const access = await requireTripAccess(trip.id, planner);
  const days = await listDays(access);

  // A split day: two wake locations with different members, which is what
  // renders the per-location member checkbox rows in the day-setup sheet.
  await addLocation(access, days[0].id, "wake", { name: "Bethlehem, Pennsylvania" });
  await addLocation(access, days[0].id, "sleep", { name: "Galway, Ireland" });
  await addLocation(access, days[1].id, "stop", { name: "Cliffs of Moher, County Clare" });

  // One of each status, so the trip page renders every row variant: a bare
  // idea, a scheduled proposal, and something locked.
  await createItem(access, { title: "Somewhere for lunch on the way", category: "dining" });
  const proposed = await createItem(access, {
    title: "Kayaking in Kinvara with the whole group",
    category: "activity",
    locationName: "Kinvara, County Galway",
    dayId: days[1].id,
  });
  await scheduleItem(access, proposed.id, new Date("2026-06-13T13:00:00Z"), new Date("2026-06-13T16:00:00Z"));

  const toLock = await createItem(access, {
    title: "Dinner at Moran's Oyster Cottage",
    category: "dining",
    locationName: "Kilcolgan, County Galway",
    dayId: days[1].id,
  });
  await scheduleItem(access, toLock.id, new Date("2026-06-13T18:30:00Z"), null);
  const locked = await lockItem(access, toLock.id, "optional");

  const invite = await createInvite(trip.id, planner);

  return {
    planner,
    member,
    tripId: trip.id,
    itemId: proposed.id,
    lockedItemId: locked.id,
    inviteToken: invite.token,
  };
}

/**
 * Sweeps a list of paths and reports *everything* wrong across all of them.
 *
 * Deliberately not an assertion per page: failing at the first one hides every
 * page after it, so a fix-rerun-fix loop discovers the damage one page at a
 * time. One report of the whole surface is the useful artifact.
 */
async function sweep(session: Session, paths: string[]): Promise<string[]> {
  const report: string[] = [];
  for (const path of paths) {
    await visit(session, `${server.baseUrl}${path}`);
    const violations = await layoutViolations(session);
    if (violations.length) report.push(formatViolations(path, violations));
  }
  return report;
}

/** Checks whatever is on screen, without navigating. */
async function here(session: Session, where: string): Promise<string[]> {
  const violations = await layoutViolations(session);
  return violations.length ? [formatViolations(where, violations)] : [];
}

function assertClean(report: string[]): void {
  assert.equal(report.length, 0, `\n${report.join("\n")}`);
}

async function withSession(fn: (s: Session) => Promise<void>): Promise<void> {
  const session = await newSession(browser);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------- signed out

test("the pages a signed-out visitor sees hold up at 390px", async () => {
  await withSession(async (s) => {
    assertClean(
      await sweep(s, [
        "/",
        "/login",
        "/login?error=That%20sign-in%20link%20is%20invalid%20or%20has%20expired.",
        "/login/check-email?email=somebody.with.a.long.address@example.test",
        `/login/password?email=${encodeURIComponent("somebody.with.a.long.address@example.test")}`,
        "/login/password?email=a%40b.test&error=That%20password%20didn%27t%20match.",
        "/login/confirm?token=whatever&next=%2Ftrips",
        `/invite/${fx.inviteToken}`,
      ]),
    );
  });
});

// ------------------------------------------------------------------ signed in

test("the pages a planner works from hold up at 390px", async () => {
  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, fx.planner.email);
    assertClean(
      await sweep(s, [
        "/trips",
        "/trips/new",
        "/profile",
        "/login/set-password?next=%2Fprofile",
        `/trip/${fx.tripId}`,
        `/trip/${fx.tripId}?tab=playspace`,
        `/trip/${fx.tripId}?tab=scratchpad`,
        `/trip/${fx.tripId}?view=all`,
        `/trip/${fx.tripId}/items/${fx.itemId}`,
        `/trip/${fx.tripId}/items/${fx.lockedItemId}`,
        `/trip/${fx.tripId}/items/${fx.itemId}/lock`,
      ]),
    );
  });
});

test("the name prompt a new joiner sees holds up at 390px", async () => {
  await withSession(async (s) => {
    // Deliberately nameless: /welcome sends anyone who has a name straight
    // through, so a named fixture would silently check the trip page twice.
    const email = `joiner-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    userCleanups.push(async () => {
      await db.delete(users).where(eq(users.email, email));
      await db.delete(loginTokens).where(eq(loginTokens.email, email));
    });

    await signInWithLink(s, server.baseUrl, email);
    await visit(s, `${server.baseUrl}/invite/${fx.inviteToken}`);
    await clickButton(s, "Join the trip");
    await s.page.waitForURL(/\/welcome$/, { timeout: 30_000 });
    assertClean(await here(s, `/trip/${fx.tripId}/welcome`));
  });
});

// --------------------------------------------------------------------- sheets

/**
 * The panels that only exist once something is tapped. Worth the interaction
 * cost: a closed <dialog> is display:none, so nothing above reaches inside one
 * -- and the day-setup sheet is exactly where six 16px checkbox labels sat
 * unnoticed, because no automated pass had ever opened it.
 */
test("the sheets hold up at 390px once they are actually open", async () => {
  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, fx.planner.email);

    // People: the roster, with roles and an invite form.
    await visit(s, `${server.baseUrl}/trip/${fx.tripId}`);
    await s.page.getByRole("button", { name: /people/i }).first().click();
    await s.page.locator("dialog[open]").waitFor({ timeout: 30_000 });
    const report = await here(s, "People sheet");

    // Day setup: wake/sleep/stops, each with a member checkbox row.
    await visit(s, `${server.baseUrl}/trip/${fx.tripId}`);
    await s.page.getByRole("button", { name: /Jun/ }).first().click();
    await clickButton(s, "Edit wake/sleep and stops");
    await s.page.locator("dialog[open]").waitFor({ timeout: 30_000 });
    report.push(...(await here(s, "day setup sheet")));

    // Add-item, in each of the shapes that swap fields in. Category is what
    // decides the form's second half, and two of those halves carry checkbox
    // rows that exist nowhere else -- the dietary tags, and a flight's
    // "International" toggle.
    await visit(s, `${server.baseUrl}/trip/${fx.tripId}?tab=playspace`);
    await clickButton(s, /^\+ /);
    await s.page.locator("dialog[open]").waitFor({ timeout: 30_000 });
    report.push(...(await here(s, "add-item sheet")));

    const category = s.page.locator('dialog[open] select[name="category"]');
    for (const value of ["lodging", "dining", "activity", "transport", "other"]) {
      await category.selectOption(value);
      report.push(...(await here(s, `add-item sheet (${value})`)));
    }

    // Flight is its own shape again: it's the only subtype with a checkbox.
    await category.selectOption("transport");
    await s.page.locator('dialog[open] select[name="subtype"]').selectOption("flight");
    report.push(...(await here(s, "add-item sheet (transport/flight)")));

    assertClean(report);
  });
});
