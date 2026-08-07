/**
 * A minimal stand-in for next/headers' cookies() and headers(), swapped in
 * only for `npm test`/`npm run test:integration` (see
 * alias-resolver-hooks.mjs) -- the real app always gets the real
 * next/headers; Next's package doesn't expose that subpath to plain Node
 * ESM resolution at all outside the framework, so anything that calls
 * cookies() or headers() (auth.ts, url.ts) can't even be imported under
 * `node --test` without something standing in for it.
 *
 * Real Next.js backs both with per-request AsyncLocalStorage; this is a
 * single process-wide store instead. That's enough to test the calling
 * code's own logic (does startSession insert a session row and read its
 * own cookie back; does absoluteOrigin() read the header it's told to read)
 * but it is NOT a substitute for testing real HTTP behavior -- Set-Cookie
 * headers, httpOnly/secure flags, per-request isolation, what a real
 * incoming request's headers actually look like. That stays Playwright's
 * job against a live server, same as before this file existed.
 */
const cookieJar = new Map();

export async function cookies() {
  return {
    get(name) {
      return cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined;
    },
    set(name, value) {
      cookieJar.set(name, value);
    },
    delete(name) {
      cookieJar.delete(name);
    },
  };
}

let currentHeaders = new Map();

export async function headers() {
  return {
    get(name) {
      return currentHeaders.get(name.toLowerCase()) ?? null;
    },
  };
}

/** Test-only escape hatch: url.integration.ts uses this to control what the next headers() call sees. */
export function __setHeaders(record) {
  currentHeaders = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
}
