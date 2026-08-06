import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDietaryFit, checkDietaryFitForItem } from "./dietary-conflicts.ts";
import type { TripMemberSummary } from "./scope.ts";

function member(
  userId: string,
  dietaryRestrictions: TripMemberSummary["dietaryRestrictions"] = null,
): TripMemberSummary {
  return {
    userId,
    email: `${userId}@example.com`,
    name: null,
    role: "participant",
    dietaryRestrictions,
    dietaryNotes: null,
  };
}

const ITEM = { id: "item-1", title: "Sushi Saito" };

test("a null accommodates means 'not analyzed' -- never a finding, no matter the member's restrictions", () => {
  const finding = checkDietaryFit(ITEM, null, member("a", ["vegan", "gluten_free"]));
  assert.equal(finding, null);
});

test("an empty accommodates array is treated the same as null -- not analyzed", () => {
  const finding = checkDietaryFit(ITEM, [], member("a", ["vegan"]));
  assert.equal(finding, null);
});

test("a member with no restrictions of their own never triggers a finding", () => {
  const finding = checkDietaryFit(ITEM, ["vegetarian"], member("a", null));
  assert.equal(finding, null);
});

test("fully covered restrictions produce no finding", () => {
  const finding = checkDietaryFit(ITEM, ["vegan", "gluten_free", "nut_free"], member("a", ["vegan", "gluten_free"]));
  assert.equal(finding, null);
});

test("an uncovered restriction produces a finding naming exactly the unmet tags", () => {
  const finding = checkDietaryFit(ITEM, ["vegetarian"], member("a", ["vegan", "gluten_free"]));
  assert.ok(finding);
  assert.deepEqual(finding.unmetTags, ["vegan", "gluten_free"]);
  assert.equal(finding.itemId, "item-1");
  assert.equal(finding.itemTitle, "Sushi Saito");
  assert.equal(finding.member.userId, "a");
});

test("partial coverage only reports the tags actually left uncovered", () => {
  const finding = checkDietaryFit(ITEM, ["vegan"], member("a", ["vegan", "shellfish_free"]));
  assert.ok(finding);
  assert.deepEqual(finding.unmetTags, ["shellfish_free"]);
});

test("checkDietaryFitForItem filters to just the attendees with an actual finding, in order", () => {
  const attendees = [
    member("fully-covered", ["vegan"]),
    member("no-restrictions", null),
    member("uncovered", ["shellfish_free"]),
    member("also-uncovered", ["halal"]),
  ];

  const findings = checkDietaryFitForItem(ITEM, ["vegan", "vegetarian"], attendees);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.member.userId),
    ["uncovered", "also-uncovered"],
  );
});

test("checkDietaryFitForItem returns nothing when the item hasn't been analyzed", () => {
  const attendees = [member("a", ["vegan"]), member("b", ["halal"])];
  assert.deepEqual(checkDietaryFitForItem(ITEM, null, attendees), []);
});
