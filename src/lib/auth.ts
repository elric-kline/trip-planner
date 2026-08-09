import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { loginTokens, sessions, users } from "@/db/schema";
import { hashPassword, verifyPasswordHash, MIN_PASSWORD_LENGTH } from "./password.ts";

const SESSION_COOKIE = "trip_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

export type CurrentUser = { id: string; email: string; name: string | null };

const newToken = () => randomBytes(32).toString("base64url");

/** Sets or replaces the user's password. Used for first-time setup and later changes alike. */
export async function setPassword(userId: string, password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const passwordHash = await hashPassword(password);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

/**
 * Whether this address can sign in with a password, used to route the one
 * email field to the right second step.
 *
 * Worth being explicit about the tradeoff: answering this to the browser
 * reveals that an address has an account *with a password set*. The
 * alternative -- showing everyone both a password box and a "send me a link"
 * box and letting them work out which applies -- is what this replaces, and it
 * asked every user to self-diagnose their own account state. An unknown
 * address is treated exactly like a known one without a password (send a
 * link), so the common signal, "does this email have an account here", still
 * isn't exposed.
 */
export async function hasPassword(email: string): Promise<boolean> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return Boolean(user?.passwordHash);
}

/** Null on any failure — unknown email, no password set yet, or a wrong one. */
export async function verifyPasswordLogin(
  email: string,
  password: string,
): Promise<CurrentUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user?.passwordHash) return null;
  if (!(await verifyPasswordHash(password, user.passwordHash))) return null;

  await startSession(user.id);
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Issues a single-use magic-link token. Returns the token so the caller can
 * build an absolute URL — it needs the request's origin, which we don't have here.
 */
export async function createLoginToken(email: string): Promise<string> {
  const token = newToken();
  await db.insert(loginTokens).values({
    token,
    email: email.trim().toLowerCase(),
    expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
  });
  return token;
}

export type RedeemedLogin = { user: CurrentUser; needsPassword: boolean };

/**
 * Redeems a login token and starts a session, creating the user on first use.
 * Returns null when the token is unknown, expired, or already spent.
 *
 * `needsPassword` is true when the account has never had one set — the caller
 * uses this to route a first-time verify to the "create a password" step
 * instead of straight into the app.
 */
export async function redeemLoginToken(token: string): Promise<RedeemedLogin | null> {
  const [row] = await db
    .select()
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.token, token),
        isNull(loginTokens.usedAt),
        gt(loginTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;

  await db
    .update(loginTokens)
    .set({ usedAt: new Date() })
    .where(eq(loginTokens.token, token));

  let [user] = await db.select().from(users).where(eq(users.email, row.email)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ email: row.email }).returning();
  }

  await startSession(user.id);
  return {
    user: { id: user.id, email: user.email, name: user.name },
    needsPassword: user.passwordHash === null,
  };
}

export async function startSession(userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ token, userId, expiresAt });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.token, token));
  jar.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return row ?? null;
}

/** For routes that have no meaning without a signed-in viewer. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}
