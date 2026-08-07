import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getProfile, RuleError, updateProfile } from "./profile.ts";
import { createTestUser } from "./test-fixtures.ts";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

test("getProfile throws for an unknown user id", async () => {
  await assert.rejects(() => getProfile(randomUUID()), RuleError);
});

test("getProfile reflects what's actually stored", async (t) => {
  const user = await createTestUser({ name: "Ada" });
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  const profile = await getProfile(user.id);
  assert.equal(profile.name, "Ada");
  assert.equal(profile.email, user.email);
  assert.equal(profile.dietaryRestrictions, null);
});

test("updateProfile: a blank name clears it, same as any other optional field", async (t) => {
  const user = await createTestUser({ name: "Original Name" });
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  await updateProfile(user, { name: "  " });
  assert.equal((await getProfile(user.id)).name, null);

  await updateProfile(user, { name: "New Name" });
  assert.equal((await getProfile(user.id)).name, "New Name");
});

test("updateProfile rejects an unrecognized dietary tag, and accepts a real one", async (t) => {
  const user = await createTestUser();
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  await assert.rejects(
    () => updateProfile(user, { dietaryRestrictions: ["vegan", "made_up_tag" as never] }),
    RuleError,
  );

  await updateProfile(user, { dietaryRestrictions: ["vegan", "gluten_free"] });
  assert.deepEqual((await getProfile(user.id)).dietaryRestrictions, ["vegan", "gluten_free"]);
});

test("updateProfile: an empty dietaryRestrictions array clears it to null, and notes trim/clear the same way", async (t) => {
  const user = await createTestUser();
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  await updateProfile(user, { dietaryRestrictions: ["halal"], dietaryNotes: "  no shellfish  " });
  const withValues = await getProfile(user.id);
  assert.deepEqual(withValues.dietaryRestrictions, ["halal"]);
  assert.equal(withValues.dietaryNotes, "no shellfish");

  await updateProfile(user, { dietaryRestrictions: [], dietaryNotes: "   " });
  const cleared = await getProfile(user.id);
  assert.equal(cleared.dietaryRestrictions, null);
  assert.equal(cleared.dietaryNotes, null);
});

test("updateProfile leaves fields untouched when the corresponding input key is simply absent", async (t) => {
  const user = await createTestUser({ name: "Keep Me" });
  t.after(() => db.delete(users).where(eq(users.id, user.id)));

  await updateProfile(user, { dietaryNotes: "vegetarian" });
  const profile = await getProfile(user.id);
  assert.equal(profile.name, "Keep Me", "name wasn't in the input, so it's untouched");
  assert.equal(profile.dietaryNotes, "vegetarian");
});
