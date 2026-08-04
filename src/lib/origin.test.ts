import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOrigin } from "./origin.ts";

test("APP_URL wins outright, regardless of environment or headers", () => {
  const origin = resolveOrigin({
    appUrl: "https://agreemobile.com/",
    isProduction: true,
    forwardedProto: "http",
    forwardedHost: "some-other-host.example",
  });
  assert.equal(origin, "https://agreemobile.com");
});

test("in production, the scheme is forced to https even if the header says otherwise", () => {
  const origin = resolveOrigin({
    isProduction: true,
    forwardedProto: "http",
    forwardedHost: "app-production.up.railway.app",
  });
  assert.equal(origin, "https://app-production.up.railway.app");
});

test("in dev, the forwarded-proto header is trusted", () => {
  const origin = resolveOrigin({
    isProduction: false,
    forwardedProto: "https",
    host: "localhost:3000",
  });
  assert.equal(origin, "https://localhost:3000");
});

test("in dev with no headers at all, falls back to plain http on localhost", () => {
  const origin = resolveOrigin({ isProduction: false });
  assert.equal(origin, "http://localhost:3000");
});

test("forwarded-host is preferred over the plain host header", () => {
  const origin = resolveOrigin({
    isProduction: false,
    forwardedHost: "public.example.com",
    host: "internal.example.com",
  });
  assert.equal(origin, "http://public.example.com");
});
