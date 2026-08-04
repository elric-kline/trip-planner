import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPasswordHash } from "./password.ts";

test("the correct password verifies against its own hash", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPasswordHash("correct horse battery staple", hash), true);
});

test("a wrong password is rejected", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPasswordHash("wrong password entirely", hash), false);
});

test("two hashes of the same password differ (salted)", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a, b);
  assert.equal(await verifyPasswordHash("same password", a), true);
  assert.equal(await verifyPasswordHash("same password", b), true);
});

test("a malformed stored value fails closed rather than throwing", async () => {
  assert.equal(await verifyPasswordHash("anything", "not-a-valid-hash"), false);
  assert.equal(await verifyPasswordHash("anything", ""), false);
});
