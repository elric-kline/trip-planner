import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteOrigin } from "./url.ts";
// @ts-expect-error -- test-only escape hatch on the fake next/headers shim; see alias-resolver-hooks.mjs.
import { __setHeaders } from "next/headers";

/**
 * url.ts is a thin wrapper: the actual decision logic (resolveOrigin) is
 * already fully unit-tested in origin.test.ts with no request context at
 * all. This just checks the wrapper reads the right headers and passes
 * them through -- using the same fake next/headers shim auth.integration.ts
 * relies on for cookies().
 */

// process.env.NODE_ENV's type is a fixed literal union, which a generic
// helper can't assign through cleanly -- this is test-only env juggling, so
// a narrow cast here is simpler than typing around it.
function withEnv(key: "APP_URL" | "NODE_ENV", value: string | undefined, fn: () => Promise<void>) {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else (process.env as Record<string, string>)[key] = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env[key];
    else (process.env as Record<string, string>)[key] = original;
  });
}

test("absoluteOrigin prefers APP_URL over any request header", async () => {
  __setHeaders({ host: "localhost:3000" });
  await withEnv("APP_URL", "https://agreemobile.com", async () => {
    assert.equal(await absoluteOrigin(), "https://agreemobile.com");
  });
});

test("absoluteOrigin falls back to forwarded headers, then plain host, when APP_URL is unset (non-production)", async () => {
  await withEnv("APP_URL", undefined, async () => {
    await withEnv("NODE_ENV", "test", async () => {
      __setHeaders({ "x-forwarded-proto": "https", "x-forwarded-host": "trip.example.com", host: "internal:3000" });
      assert.equal(await absoluteOrigin(), "https://trip.example.com");

      __setHeaders({ host: "localhost:3000" });
      assert.equal(await absoluteOrigin(), "http://localhost:3000");
    });
  });
});

test("absoluteOrigin forces https in production regardless of the forwarded proto", async () => {
  await withEnv("APP_URL", undefined, async () => {
    await withEnv("NODE_ENV", "production", async () => {
      __setHeaders({ "x-forwarded-proto": "http", host: "agreemobile.com" });
      assert.equal(await absoluteOrigin(), "https://agreemobile.com");
    });
  });
});
