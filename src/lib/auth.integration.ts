import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { loginTokens, sessions, users } from "@/db/schema";
import {
  createLoginToken,
  getCurrentUser,
  redeemLoginToken,
  setPassword,
  signOut,
  startSession,
  verifyPasswordLogin,
} from "./auth.ts";
import { verifyPasswordHash } from "./password.ts";

/**
 * Integration coverage for auth.ts: password hashing, magic-link token
 * issuance/redemption, and the session lifecycle it all funnels into.
 *
 * auth.ts calls next/headers' cookies() to start/read/end a session, which
 * normally only works inside a real Next.js request. The test run swaps in
 * a fake in-memory cookies() (see fake-next-headers.mjs, registered by
 * alias-resolver-hooks.mjs) so this file's own real logic runs end to end --
 * but that fake is a single process-wide jar, not per-request, so real HTTP
 * cookie behavior (Set-Cookie headers, httpOnly/secure flags, isolation
 * between concurrent requests) is still Playwright's job against a live
 * server, not this file's.
 */

async function makeUser() {
  const [user] = await db
    .insert(users)
    .values({ email: `auth-test-${randomUUID()}@example.test` })
    .returning();
  return user;
}

test("setPassword enforces the minimum length and never stores the plaintext", async (t) => {
  const user = await makeUser();
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  await assert.rejects(() => setPassword(user.id, "short"));

  await setPassword(user.id, "a-fine-password");
  const [row] = await db.select().from(users).where(eq(users.id, user.id));
  assert.ok(row.passwordHash, "a hash was stored");
  assert.ok(!row.passwordHash!.includes("a-fine-password"), "not the plaintext");
  assert.equal(await verifyPasswordHash("a-fine-password", row.passwordHash!), true);
  assert.equal(await verifyPasswordHash("wrong-password", row.passwordHash!), false);
});

test("createLoginToken normalizes the email and expires ~15 minutes out", async (t) => {
  const before = Date.now();
  const token = await createLoginToken("  Mixed-Case@Example.com  ");
  t.after(() => db.delete(loginTokens).where(eq(loginTokens.token, token)));

  const [row] = await db.select().from(loginTokens).where(eq(loginTokens.token, token));
  assert.equal(row.email, "mixed-case@example.com");
  const ttlMinutes = (row.expiresAt.getTime() - before) / 60_000;
  assert.ok(ttlMinutes > 14 && ttlMinutes <= 15.5, `expected ~15 min TTL, got ${ttlMinutes}`);
});

test("redeemLoginToken rejects an unknown token", async () => {
  const result = await redeemLoginToken("this-token-does-not-exist");
  assert.equal(result, null);
});

test("redeemLoginToken rejects an expired token, without consuming it", async (t) => {
  const token = randomUUID();
  await db.insert(loginTokens).values({
    token,
    email: "expired@example.test",
    expiresAt: new Date(Date.now() - 1000), // already expired
  });
  t.after(() => db.delete(loginTokens).where(eq(loginTokens.token, token)));

  const result = await redeemLoginToken(token);
  assert.equal(result, null);

  const [row] = await db.select().from(loginTokens).where(eq(loginTokens.token, token));
  assert.equal(row.usedAt, null, "an expired token is rejected, not marked used");
});

test("a used login token can't be redeemed twice", async (t) => {
  const token = randomUUID();
  await db.insert(loginTokens).values({
    token,
    email: "already-used@example.test",
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: new Date(), // simulates an already-redeemed token, without needing a session
  });
  t.after(() => db.delete(loginTokens).where(eq(loginTokens.token, token)));

  const result = await redeemLoginToken(token);
  assert.equal(result, null, "a token with usedAt set is rejected even before expiry");
});

test("redeeming a fresh token starts a session, creates the user on first use, and flags needsPassword", async (t) => {
  const email = `first-timer-${randomUUID()}@example.test`;
  const token = await createLoginToken(email);
  t.after(async () => {
    await db.delete(loginTokens).where(eq(loginTokens.token, token));
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (u) {
      await db.delete(sessions).where(eq(sessions.userId, u.id));
      await db.delete(users).where(eq(users.id, u.id));
    }
  });

  const result = await redeemLoginToken(token);
  assert.ok(result, "redemption succeeds");
  assert.equal(result!.user.email, email);
  assert.equal(result!.needsPassword, true, "a brand-new user has no password yet");

  const me = await getCurrentUser();
  assert.equal(me?.email, email, "the session it started is the current one");

  const [tokenRow] = await db.select().from(loginTokens).where(eq(loginTokens.token, token));
  assert.ok(tokenRow.usedAt, "the token is now marked used");

  const second = await redeemLoginToken(token);
  assert.equal(second, null, "and can't be redeemed again");
});

test("verifyPasswordLogin: null on a wrong password or unknown email; starts a session on success", async (t) => {
  const user = await makeUser();
  await setPassword(user.id, "correct-horse-battery");
  t.after(async () => {
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  });

  assert.equal(await verifyPasswordLogin("nobody@example.test", "correct-horse-battery"), null);
  assert.equal(await verifyPasswordLogin(user.email, "wrong-password"), null);

  const logged = await verifyPasswordLogin(user.email, "correct-horse-battery");
  assert.equal(logged?.id, user.id);

  const me = await getCurrentUser();
  assert.equal(me?.id, user.id);
});

test("signOut ends the current session -- getCurrentUser returns null after", async (t) => {
  const user = await makeUser();
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  await startSession(user.id);
  assert.equal((await getCurrentUser())?.id, user.id, "session is active");

  await signOut();
  assert.equal(await getCurrentUser(), null, "session is gone");
});
