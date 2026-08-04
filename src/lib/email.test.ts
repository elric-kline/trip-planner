import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMagicLink, emailDeliveryConfigured } from "./email.ts";

function clearEnv() {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
}

test("with no provider configured, logs instead of sending", async (t) => {
  clearEnv();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when unconfigured");
  });

  assert.equal(emailDeliveryConfigured(), false);
  await sendMagicLink("someone@example.com", "https://example.com/login/confirm?token=abc");
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("with only one of the two env vars set, still falls back to console", async (t) => {
  clearEnv();
  process.env.EMAIL_FROM = "AgreeMobile <sign-in@agreemobile.com>";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called when only half-configured");
  });

  assert.equal(emailDeliveryConfigured(), false);
  await sendMagicLink("someone@example.com", "https://example.com/login/confirm?token=abc");
  assert.equal(fetchMock.mock.calls.length, 0);
  clearEnv();
});

test("with both env vars set, posts to the Resend API with the right shape", async (t) => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "AgreeMobile <sign-in@agreemobile.com>";

  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ id: "abc123" }), { status: 200 }),
  );

  assert.equal(emailDeliveryConfigured(), true);
  await sendMagicLink("someone@example.com", "https://example.com/login/confirm?token=abc");

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer re_test_key");

  const body = JSON.parse(init.body as string);
  assert.equal(body.from, "AgreeMobile <sign-in@agreemobile.com>");
  assert.equal(body.to, "someone@example.com");
  assert.match(body.html, /https:\/\/example\.com\/login\/confirm\?token=abc/);
  assert.match(body.text, /https:\/\/example\.com\/login\/confirm\?token=abc/);

  clearEnv();
});

test("a non-ok response from Resend throws rather than silently dropping the email", async (t) => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "AgreeMobile <sign-in@agreemobile.com>";

  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("domain not verified", { status: 422 }),
  );

  await assert.rejects(
    () => sendMagicLink("someone@example.com", "https://example.com/login/confirm?token=abc"),
    /Resend API error \(422\)/,
  );

  clearEnv();
});
