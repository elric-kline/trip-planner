/**
 * A minimal stand-in for next/headers' cookies(), swapped in only for
 * `npm test` (see alias-resolver-hooks.mjs) -- the real app always gets the
 * real next/headers; Next's package doesn't expose that subpath to plain
 * Node ESM resolution at all outside the framework, so auth.ts (which calls
 * cookies() to start/read/end a session) can't even be imported under
 * `node --test` without something standing in for it.
 *
 * Real Next.js backs cookies() with per-request AsyncLocalStorage; this is
 * a single process-wide in-memory jar instead. That's enough to test
 * auth.ts's own logic (does startSession insert a session row and store a
 * token this process can read back; does signOut delete both) but it is
 * NOT a substitute for testing real HTTP cookie behavior -- Set-Cookie
 * headers, httpOnly/secure flags, per-request isolation. That stays
 * Playwright's job against a live server, same as before this file existed.
 */
const jar = new Map();

export async function cookies() {
  return {
    get(name) {
      return jar.has(name) ? { name, value: jar.get(name) } : undefined;
    },
    set(name, value) {
      jar.set(name, value);
    },
    delete(name) {
      jar.delete(name);
    },
  };
}
