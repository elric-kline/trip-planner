import { test } from "node:test";
import assert from "node:assert/strict";
import { displayName, displayNameWithEmail } from "./display-name.ts";

test("a real name always wins", () => {
  assert.equal(displayName({ name: "Ana García", email: "ana@example.com" }), "Ana García");
  assert.equal(displayName({ name: "  Ana  ", email: "ana@example.com" }), "Ana");
});

test("without a name, the local part stands in -- separators read as spaces", () => {
  assert.equal(displayName({ name: null, email: "ana.garcia@example.com" }), "ana garcia");
  assert.equal(displayName({ name: null, email: "ana_garcia@example.com" }), "ana garcia");
  assert.equal(displayName({ name: null, email: "ana-garcia@example.com" }), "ana garcia");
  assert.equal(displayName({ name: "", email: "ana@example.com" }), "ana");
});

test("a local part that reduces to nothing falls back to the address itself", () => {
  assert.equal(displayName({ name: null, email: "___@example.com" }), "___@example.com");
  assert.equal(displayName({ name: null, email: "weird" }), "weird");
});

test("displayNameWithEmail doesn't repeat an address that's already all we have", () => {
  assert.equal(
    displayNameWithEmail({ name: "Ana", email: "ana@example.com" }),
    "Ana · ana@example.com",
  );
  assert.equal(
    displayNameWithEmail({ name: null, email: "weird" }),
    "weird",
    "no point printing it twice",
  );
});
