import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { loginTokens } from "@/db/schema";

/**
 * Smoke-layer harness: boots the real production build, drives it in a real
 * browser, and asserts three things and only three things --
 *
 *   1. the HTTP status of a page,
 *   2. where a redirect chain finally lands, and
 *   3. that nothing threw or logged an error in the browser.
 *
 * The deliberate absence of DOM assertions is the design. This repo's manual
 * Playwright passes have repeatedly produced findings that turned out to be
 * bugs in the *harness* rather than the app -- a closed <dialog> counted as
 * rendered, `find()` over `main div` silently degrading a banner check into
 * "is this string anywhere on the page", `button:has-text("Delete")` matching
 * two different buttons, `networkidle` racing a server-action redirect.
 * Every one of those was a selector or a wait, written slightly wrong, failing
 * quietly in the direction of passing.
 *
 * A URL cannot be asserted subtly wrong. It equals "/trips" or it does not.
 * That property is what makes this layer safe to gate merges on, and it's why
 * the assertion vocabulary here is intentionally tiny -- anything richer
 * belongs in a test that doesn't need a browser.
 *
 * Not a *.smoke.ts file itself, so `node --test`'s glob never runs it -- same
 * arrangement as test-fixtures.ts for the integration suites.
 */

/** Where the app under test lives, once startServer() has it up. */
export type Server = {
  baseUrl: string;
  stop: () => Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    // Port 0 asks the OS for any free port; we then hand that number to Next.
    // There's a theoretical race between closing this and Next binding it,
    // but the alternative -- a fixed port -- collides with a dev server on
    // every developer's machine, which is a certainty rather than a race.
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts `next start` against the existing production build.
 *
 * Production, not `next dev`, for two reasons that both matter to this layer:
 * dev injects its own overlay and dev-only console warnings, which would make
 * the "no console errors" assertion meaningless; and NODE_ENV=production is
 * what flips the session cookie to `Secure`. Chromium treats loopback as a
 * trustworthy origin and stores `Secure` cookies over plain http there, so
 * signed-in flows work without TLS -- verified, not assumed.
 */
export async function startServer(): Promise<Server> {
  if (!existsSync(".next/BUILD_ID")) {
    throw new Error("No production build found — run `npm run build` before `npm run test:smoke`.");
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port) },
  });

  // Kept so a failed boot can say what the server actually printed, rather
  // than only "it never came up".
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // next start can sit on open keep-alive sockets; don't hang CI over it.
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited with ${child.exitCode} before serving:\n${output}`);
    }
    try {
      const res = await fetch(baseUrl, { redirect: "manual" });
      if (res.status > 0) return { baseUrl, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  await stop();
  throw new Error(`next start never became ready on ${baseUrl}:\n${output}`);
}

export async function startBrowser(): Promise<Browser> {
  return chromium.launch({
    // Set by the CI image (and by any local `npx playwright install`); left
    // undefined, Playwright resolves its own download.
    executablePath: process.env.SMOKE_CHROMIUM || undefined,
  });
}

/**
 * One browser context -- i.e. one signed-in identity, or none. Every page
 * error and console error is collected from the moment the session opens, so
 * a check at the end of a flow covers everything that happened during it,
 * including on pages we only passed through.
 */
export type Session = {
  page: Page;
  context: BrowserContext;
  clientErrors: string[];
  close: () => Promise<void>;
};

export async function newSession(browser: Browser): Promise<Session> {
  const context = await browser.newContext({
    // The brief for this app is mobile-first, so the smoke pass drives the
    // viewport people actually use. It changes which elements render (the
    // responsive prefixes), so it changes what a flow exercises.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const clientErrors: string[] = [];

  page.on("pageerror", (err) => clientErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") clientErrors.push(`console.error: ${msg.text()}`);
  });

  return { page, context, clientErrors, close: () => context.close() };
}

/**
 * Signs in the way a person does: ask for a link, then redeem it. The token
 * comes from the database rather than from a parsed email because delivery
 * isn't configured in CI -- but everything either side of it is the real
 * path, including the POST-only redemption (see the confirm page for why a
 * GET must not redeem).
 *
 * Returns where the app *chose* to send them, which is itself under test:
 * this used to detour every passwordless sign-in through "create a password".
 */
export async function signInWithLink(
  session: Session,
  baseUrl: string,
  email: string,
  next = "/trips",
): Promise<string> {
  const { page } = session;
  await page.goto(`${baseUrl}/login?next=${encodeURIComponent(next)}`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await clickButton(session, "Continue");
  await page.waitForURL("**/login/check-email**", { timeout: 30_000 });
  await waitForHydration(session);

  const token = await latestLoginToken(email);
  await page.goto(`${baseUrl}/login/confirm?token=${token}&next=${encodeURIComponent(next)}`, {
    waitUntil: "domcontentloaded",
  });
  await clickButton(session, "Confirm sign-in");
  await page.waitForURL((url) => !url.pathname.startsWith("/login/confirm"), { timeout: 30_000 });
  await waitForHydration(session);
  return pathOf(page.url());
}

export async function latestLoginToken(email: string): Promise<string> {
  const [row] = await db
    .select({ token: loginTokens.token })
    .from(loginTokens)
    .where(eq(loginTokens.email, email.trim().toLowerCase()))
    .orderBy(desc(loginTokens.createdAt))
    .limit(1);
  if (!row) throw new Error(`no login token was issued for ${email}`);
  return row.token;
}

/**
 * Clicks a button by its accessible name.
 *
 * By name rather than by `button[type="submit"]` because that attribute is
 * optional -- a bare <button> inside a form already submits, and several here
 * are written that way, so the selector matched on some pages and not others.
 * A wrong name here times out loudly, which is the failure mode this layer
 * wants: click targets may be brittle, assertions may not.
 */
export async function clickButton(session: Session, name: string | RegExp): Promise<void> {
  await session.page.getByRole("button", { name }).click({ timeout: 30_000 });
}

/** Pathname only -- the assertion vocabulary for "where did this land". */
export function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** Pathname plus the query params a caller names, for redirects that carry state. */
export function pathAndParams(url: string, params: string[]): string {
  const u = new URL(url);
  const kept = params
    .filter((p) => u.searchParams.has(p))
    .map((p) => `${p}=${u.searchParams.get(p)}`);
  return kept.length ? `${u.pathname}?${kept.join("&")}` : u.pathname;
}

/**
 * Blocks until React has actually hydrated the page.
 *
 * This is load-bearing for the "no client errors" assertion, not a nicety.
 * At `domcontentloaded` the server HTML is present and `__reactContainer$` is
 * already on `document`, but no client component has run yet -- so a check
 * made at that point sees a clean console on a page that is about to throw.
 * Verified by mutation: a `console.error` added to a client component went
 * completely undetected until this wait existed.
 *
 * `__reactFiber$` on document.body is the signal, because it only appears
 * once hydration has committed. Every page shares the root layout, so every
 * page gets one.
 */
export async function waitForHydration(session: Session): Promise<void> {
  await session.page.waitForFunction(
    () => Object.keys(document.body).some((k) => k.startsWith("__reactFiber$")),
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * Navigates and reports the status of the page that was finally rendered.
 * Next answers a server-side `redirect()` with a 3xx that the browser
 * follows, so this is "did the destination render", not "was there a hop".
 * Where the hop went is what `pathOf` is for.
 */
export async function visit(session: Session, url: string): Promise<number> {
  const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
  if (!response) throw new Error(`no response for ${url}`);
  // A 404 renders Next's own not-found page, which hydrates like any other;
  // anything else that fails to hydrate should fail the flow, so no special
  // case here.
  await waitForHydration(session);
  return response.status();
}
