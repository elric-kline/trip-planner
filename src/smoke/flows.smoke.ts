import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright";
import {
  clickButton,
  newSession,
  pathAndParams,
  pathOf,
  signInWithLink,
  startBrowser,
  startServer,
  visit,
  waitForHydration,
  type Server,
  type Session,
} from "./harness.ts";
import { db } from "@/db";
import { loginTokens, users } from "@/db/schema";
import { createTestUser, cleanupTrip } from "@/lib/test-fixtures.ts";
import { createInvite, createTrip } from "@/lib/trips.ts";
import type { CurrentUser } from "@/lib/auth.ts";

/**
 * Route and redirect smoke over the whole signed-out/signed-in surface.
 *
 * `src/app` has no other automated coverage: nine server-action modules and
 * ~57 `redirect()` call sites, all excluded from the coverage floor by design
 * (see ci.yml). The defects that reached main from that surface were never
 * subtle logic errors -- they were *destinations*. Redeeming a sign-in link
 * detoured through "create a password". Accepting an invite has to choose
 * between three landing pages depending on the joiner's name and the trip's
 * shape. A non-member opening a trip URL has to go somewhere safe.
 *
 * So this file asserts destinations, and nothing else. See harness.ts for why
 * the vocabulary is deliberately that small.
 */

let server: Server;
let browser: Browser;

// Trips are torn down before users: users.id is referenced by items.createdBy
// with no cascade, so the reverse order fails the foreign key. Same reasoning
// as cleanupTrip's own, one level up.
const tripCleanups: (() => Promise<void>)[] = [];
const userCleanups: (() => Promise<void>)[] = [];

before(async () => {
  server = await startServer();
  browser = await startBrowser();
});

after(async () => {
  for (const fn of tripCleanups) await fn().catch(() => {});
  for (const fn of userCleanups) await fn().catch(() => {});
  await browser?.close();
  await server?.stop();
});

/**
 * A throwaway address, registered for teardown as it's minted. Signing in
 * with one creates a real user row (redeeming a link is also how you sign
 * up), so nothing else has to remember to clean it up.
 */
function uniqueEmail(label: string): string {
  const email = `${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  userCleanups.push(async () => {
    await db.delete(users).where(eq(users.email, email));
    await db.delete(loginTokens).where(eq(loginTokens.email, email));
  });
  return email;
}

function trackUser(user: CurrentUser): CurrentUser {
  userCleanups.push(async () => {
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(loginTokens).where(eq(loginTokens.email, user.email));
  });
  return user;
}

/** A trip owned by a fresh user, made through the library rather than the UI. */
async function seedTrip(owner: CurrentUser) {
  const trip = await createTrip(owner, {
    name: `Smoke ${randomUUID().slice(0, 8)}`,
    destination: "Galway, Ireland",
    startDate: "2026-06-12",
    endDate: "2026-06-14",
    timezone: "Europe/Dublin",
  });
  tripCleanups.push(() => cleanupTrip(trip.id, []));
  return trip;
}

/** Opens a session and guarantees it's torn down even if the test throws. */
async function withSession(
  fn: (s: Session) => Promise<void>,
  // Set only by a flow that asks for a URL it expects to be missing: Chromium
  // logs a console error for the failed navigation itself, which is the same
  // fact `visit` already returns as a status code. Narrow and opt-in, so a
  // genuinely missing stylesheet or script still fails every other flow.
  opts: { expectsAMissingUrl?: boolean } = {},
): Promise<void> {
  const session = await newSession(browser);
  try {
    await fn(session);
    // The flow's last navigation may have been a click, which resolves on the
    // URL changing rather than on hydration -- so settle before reading the
    // error list, or the final page's client code has not run yet.
    await waitForHydration(session);
    const unexpected = opts.expectsAMissingUrl
      ? session.clientErrors.filter((e) => !e.includes("Failed to load resource"))
      : session.clientErrors;
    // Checked after the flow rather than per-navigation: a client error on a
    // page we merely passed through is still a client error.
    assert.deepEqual(unexpected, [], "the browser reported errors during this flow");
  } finally {
    await session.close();
  }
}

/** Sets a password through the real UI, which is now only reachable from Profile. */
async function setPasswordViaUi(s: Session, password: string): Promise<void> {
  await visit(s, `${server.baseUrl}/login/set-password?next=%2Fprofile`);
  await s.page.locator('input[name="password"]').fill(password);
  await s.page.locator('input[name="confirm"]').fill(password);
  await clickButton(s, /^(Set|Change) password$/);
  await s.page.waitForURL((url) => url.pathname === "/profile", { timeout: 30_000 });
}

// ---------------------------------------------------------------- signed out

test("a signed-out visitor gets the homepage, and the sign-in page, at 200", async () => {
  await withSession(async (s) => {
    assert.equal(await visit(s, `${server.baseUrl}/`), 200);
    assert.equal(pathOf(s.page.url()), "/", "the homepage must not bounce a signed-out visitor");
    assert.equal(await visit(s, `${server.baseUrl}/login`), 200);
    assert.equal(pathOf(s.page.url()), "/login");
  });
});

test("an unknown path is a 404, not a page that happens to render", async () => {
  await withSession(async (s) => {
    // Guards against a catch-all route quietly swallowing every typo'd URL.
    assert.equal(await visit(s, `${server.baseUrl}/no-such-page-${randomUUID()}`), 404);
  }, { expectsAMissingUrl: true });
});

test("every signed-in route bounces a signed-out visitor to sign-in, carrying where they were going", async () => {
  const tripId = randomUUID();
  const guarded = ["/trips", "/trips/new", "/profile", `/trip/${tripId}`];

  await withSession(async (s) => {
    for (const path of guarded) {
      await visit(s, `${server.baseUrl}${path}`);
      assert.equal(
        pathAndParams(s.page.url(), ["next"]),
        `/login?next=${path}`,
        `${path} should bounce to sign-in and remember the destination`,
      );
    }

    // The one deliberate exception: the name prompt sends a signed-out
    // visitor to the *trip*, not back to itself. You can only legitimately
    // reach /welcome by having just accepted an invite, so after signing in
    // the trip is the useful destination and the prompt would be noise.
    await visit(s, `${server.baseUrl}/trip/${tripId}/welcome`);
    assert.equal(pathAndParams(s.page.url(), ["next"]), `/login?next=/trip/${tripId}`);
  });
});

test("an invite link is readable signed out — that is the whole point of it", async () => {
  const owner = trackUser(await createTestUser({ name: "Ana Planner" }));
  const trip = await seedTrip(owner);
  const invite = await createInvite(trip.id, owner);

  await withSession(async (s) => {
    assert.equal(await visit(s, `${server.baseUrl}/invite/${invite.token}`), 200);
    assert.equal(pathOf(s.page.url()), `/invite/${invite.token}`);
  });
});

// ------------------------------------------------------------------ sign-in

test("redeeming a link lands where you were going, with no password detour", async () => {
  await withSession(async (s) => {
    const landed = await signInWithLink(s, server.baseUrl, uniqueEmail("nopass"));
    // The regression this exists for: /login/set-password used to be
    // interposed here on every passwordless sign-in.
    assert.equal(landed, "/trips");
  });
});

test("a `next` destination survives the whole link round trip", async () => {
  await withSession(async (s) => {
    const landed = await signInWithLink(s, server.baseUrl, uniqueEmail("nextparam"), "/trips/new");
    assert.equal(landed, "/trips/new");
  });
});

test("an invalid sign-in token returns to the front door with an error, not a crash", async () => {
  await withSession(async (s) => {
    await visit(s, `${server.baseUrl}/login/confirm?token=not-a-real-token&next=%2Ftrips`);
    await clickButton(s, "Confirm sign-in");
    await s.page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
    assert.ok(new URL(s.page.url()).searchParams.get("error"), "the bounce should say why");
  });
});

test("an address with a password goes to the password step; a wrong answer stays there", async () => {
  const email = uniqueEmail("haspass");
  const password = "a-fine-smoke-password";

  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, email);
    await setPasswordViaUi(s, password);
  });

  // A fresh session: no cookie, so this is the real returning-user path.
  await withSession(async (s) => {
    await visit(s, `${server.baseUrl}/login`);
    await s.page.locator('input[name="email"]').fill(email);
    await clickButton(s, "Continue");
    await s.page.waitForURL((url) => url.pathname === "/login/password", { timeout: 30_000 });

    await s.page.locator('input[name="password"]').fill("not-the-password");
    await clickButton(s, "Sign in");
    await s.page.waitForURL((url) => url.searchParams.has("error"), { timeout: 30_000 });
    // Back to the step that failed, not to the start -- a typo should cost
    // one field, and the address is already known good by this point.
    assert.equal(pathOf(s.page.url()), "/login/password");

    await s.page.locator('input[name="password"]').fill(password);
    await clickButton(s, "Sign in");
    await s.page.waitForURL((url) => url.pathname === "/trips", { timeout: 30_000 });
  });
});

test("having a password never traps you into remembering it", async () => {
  const email = uniqueEmail("escape");
  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, email);
    await setPasswordViaUi(s, "another-fine-password");
  });

  await withSession(async (s) => {
    // "Email me a sign-in link instead".
    await visit(s, `${server.baseUrl}/login/password?email=${encodeURIComponent(email)}`);
    await clickButton(s, "Email me a sign-in link instead");
    await s.page.waitForURL((url) => url.pathname === "/login/check-email", { timeout: 30_000 });

    // "Not you?" -- back to the one-field front door.
    await visit(s, `${server.baseUrl}/login/password?email=${encodeURIComponent(email)}`);
    await s.page.locator('a:has-text("Not you?")').click();
    await s.page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
  });
});

test("the password step with no address to sign in as returns to the front door", async () => {
  await withSession(async (s) => {
    await visit(s, `${server.baseUrl}/login/password`);
    assert.equal(pathOf(s.page.url()), "/login");
  });
});

// -------------------------------------------------------------------- trips

test("creating a trip lands in PlaySpace, the only tab a new trip can fill", async () => {
  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, uniqueEmail("creator"), "/trips/new");
    await s.page.locator('input[name="name"]').fill("Smoke trip");
    await s.page.locator('input[name="destination"]').fill("Galway, Ireland");
    await s.page.locator('input[name="startDate"]').fill("2026-06-12");
    await s.page.locator('input[name="endDate"]').fill("2026-06-14");
    await clickButton(s, "Create trip");
    await s.page.waitForURL(/\/trip\/[0-9a-f-]{36}/, { timeout: 30_000 });

    const url = new URL(s.page.url());
    assert.match(url.pathname, /^\/trip\/[0-9a-f-]{36}$/);
    // Agreed cannot have content on a trip seconds old; PlaySpace is where
    // the first idea actually goes.
    assert.equal(url.searchParams.get("tab"), "playspace");

    tripCleanups.push(() => cleanupTrip(url.pathname.split("/")[2], []));
  });
});

test("a non-member opening a trip URL is sent to their own trip list, not shown the trip", async () => {
  const owner = trackUser(await createTestUser({ name: "Ana Planner" }));
  const trip = await seedTrip(owner);

  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, uniqueEmail("outsider"));
    await visit(s, `${server.baseUrl}/trip/${trip.id}`);
    assert.equal(pathOf(s.page.url()), "/trips");
  });
});

// ------------------------------------------------------------------ invites

test("accepting an invite asks a nameless joiner for a name, once", async () => {
  const owner = trackUser(await createTestUser({ name: "Ana Planner" }));
  const trip = await seedTrip(owner);
  const invite = await createInvite(trip.id, owner);

  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, uniqueEmail("joiner"));
    await visit(s, `${server.baseUrl}/invite/${invite.token}`);
    await clickButton(s, "Join the trip");
    await s.page.waitForURL(/\/trip\//, { timeout: 30_000 });
    assert.equal(pathOf(s.page.url()), `/trip/${trip.id}/welcome`);

    await s.page.locator('input[name="name"]').fill("Bern");
    await clickButton(s, "Continue");
    await s.page.waitForURL((url) => url.pathname === `/trip/${trip.id}`, { timeout: 30_000 });

    // The point of "once": a member who has a name must not be able to land
    // back on the prompt, or it becomes a step people learn to dismiss.
    await visit(s, `${server.baseUrl}/trip/${trip.id}/welcome`);
    assert.equal(pathOf(s.page.url()), `/trip/${trip.id}`);
  });
});

test("a joiner who already has a name goes straight to the trip", async () => {
  const owner = trackUser(await createTestUser({ name: "Ana Planner" }));
  const trip = await seedTrip(owner);
  const named = trackUser(await createTestUser({ name: "Cass Already-Named" }));
  const invite = await createInvite(trip.id, owner);

  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, named.email);
    await visit(s, `${server.baseUrl}/invite/${invite.token}`);
    await clickButton(s, "Join the trip");
    await s.page.waitForURL(/\/trip\//, { timeout: 30_000 });
    assert.equal(pathOf(s.page.url()), `/trip/${trip.id}`);
  });
});

test("an invite that isn't real reports itself rather than half-joining anyone", async () => {
  await withSession(async (s) => {
    const token = `not-a-real-invite-${randomUUID()}`;
    await signInWithLink(s, server.baseUrl, uniqueEmail("badinvite"));
    await visit(s, `${server.baseUrl}/invite/${token}`);
    await clickButton(s, "Join the trip");
    await s.page.waitForURL((url) => url.searchParams.has("error"), { timeout: 30_000 });
    assert.equal(pathOf(s.page.url()), `/invite/${token}`);
  });
});

test("an email-scoped invite refuses a different address", async () => {
  const owner = trackUser(await createTestUser({ name: "Ana Planner" }));
  const trip = await seedTrip(owner);
  const invite = await createInvite(trip.id, owner, { email: "intended@example.test" });

  await withSession(async (s) => {
    await signInWithLink(s, server.baseUrl, uniqueEmail("wrongaddress"));
    await visit(s, `${server.baseUrl}/invite/${invite.token}`);
    await clickButton(s, "Join the trip");
    await s.page.waitForURL((url) => url.searchParams.has("error"), { timeout: 30_000 });
    assert.equal(pathOf(s.page.url()), `/invite/${invite.token}`);
    // Still not a member: the trip is not reachable.
    await visit(s, `${server.baseUrl}/trip/${trip.id}`);
    assert.equal(pathOf(s.page.url()), "/trips");
  });
});
