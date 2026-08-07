import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDecline,
  checkLock,
  checkPropose,
  checkRestore,
  checkRsvp,
  checkShare,
  checkUnlock,
  checkUnschedule,
  statusForTime,
  type LifecycleItem,
} from "./lifecycle.ts";

const idea: LifecycleItem = {
  status: "idea",
  visibility: "group",
  commitment: null,
  startsAt: null,
  endsAt: null,
};

const planner = { isPlanner: true, isAuthor: false };
const author = { isPlanner: false, isAuthor: true };
const stranger = { isPlanner: false, isAuthor: false };

test("statusForTime: an item with a time is a proposal, otherwise an idea", () => {
  assert.equal(statusForTime(new Date()), "proposed");
  assert.equal(statusForTime(null), "idea");
});

test("propose: author may schedule their own idea", () => {
  assert.deepEqual(checkPropose(idea, author, new Date()), { ok: true });
});

test("propose: a stranger may not schedule someone else's idea", () => {
  const result = checkPropose(idea, stranger, new Date());
  assert.equal(result.ok, false);
});

test("propose: a planner may schedule anyone's idea", () => {
  assert.deepEqual(checkPropose(idea, planner, new Date()), { ok: true });
});

test("propose: cannot schedule a locked item — must unlock first", () => {
  const locked: LifecycleItem = { ...idea, status: "locked", commitment: "required" };
  const result = checkPropose(locked, planner, new Date());
  assert.equal(result.ok, false);
});

test("propose: requires a start time", () => {
  const result = checkPropose(idea, author, null);
  assert.equal(result.ok, false);
});

test("lock: group item requires a planner and a commitment", () => {
  const proposed: LifecycleItem = { ...idea, status: "proposed", startsAt: new Date() };

  assert.equal(checkLock(proposed, author, "required").ok, false, "author alone can't lock a group item");
  assert.equal(checkLock(proposed, planner, null).ok, false, "planner must choose required/optional");
  assert.deepEqual(checkLock(proposed, planner, "required"), { ok: true });
});

test("lock: private item is locked by its author with no commitment", () => {
  const proposed: LifecycleItem = {
    ...idea,
    status: "proposed",
    visibility: "private",
    startsAt: new Date(),
  };

  assert.equal(checkLock(proposed, planner, "required").ok, false, "planner can't lock someone's private item");
  assert.equal(checkLock(proposed, author, "required").ok, false, "private items take no commitment");
  assert.deepEqual(checkLock(proposed, author, null), { ok: true });
});

test("lock: end time must be after start time", () => {
  const start = new Date("2026-06-01T10:00:00Z");
  const proposed: LifecycleItem = {
    ...idea,
    status: "proposed",
    startsAt: start,
    endsAt: new Date(start.getTime() - 1000),
  };
  assert.equal(checkLock(proposed, planner, "required").ok, false);
});

test("unlock: planner unlocks a group item, private item needs its author", () => {
  const lockedGroup: LifecycleItem = { ...idea, status: "locked", commitment: "required" };
  assert.deepEqual(checkUnlock(lockedGroup, planner), { ok: true });
  assert.equal(checkUnlock(lockedGroup, author).ok, false);

  const lockedPrivate: LifecycleItem = { ...lockedGroup, visibility: "private", commitment: null };
  assert.equal(checkUnlock(lockedPrivate, planner).ok, false);
  assert.deepEqual(checkUnlock(lockedPrivate, author), { ok: true });
});

test("unschedule: only from proposed, only by author or planner", () => {
  const proposed: LifecycleItem = { ...idea, status: "proposed", startsAt: new Date() };
  assert.deepEqual(checkUnschedule(proposed, author), { ok: true });
  assert.equal(checkUnschedule(proposed, stranger).ok, false);
  assert.equal(checkUnschedule(idea, author).ok, false, "an idea has nothing to unschedule");
});

test("decline: cannot decline a locked item without unlocking first", () => {
  const locked: LifecycleItem = { ...idea, status: "locked", commitment: "optional" };
  assert.equal(checkDecline(locked, planner).ok, false);
  assert.deepEqual(checkDecline(idea, author), { ok: true });
});

test("restore: only a declined item can be restored", () => {
  const declined: LifecycleItem = { ...idea, status: "declined" };
  assert.deepEqual(checkRestore(declined, author), { ok: true });
  assert.equal(checkRestore(idea, author).ok, false);
});

test("rsvp: only valid on locked, optional, group items", () => {
  assert.equal(checkRsvp(idea).ok, false, "not locked");

  const requiredLocked: LifecycleItem = { ...idea, status: "locked", commitment: "required" };
  assert.equal(checkRsvp(requiredLocked).ok, false, "required items don't take RSVPs");

  const privateLocked: LifecycleItem = {
    ...idea,
    status: "locked",
    visibility: "private",
    commitment: null,
  };
  assert.equal(checkRsvp(privateLocked).ok, false, "private items don't take RSVPs");

  const optionalLocked: LifecycleItem = { ...idea, status: "locked", commitment: "optional" };
  assert.deepEqual(checkRsvp(optionalLocked), { ok: true });
});

test("share: author-only, must not already be group, and must not be locked", () => {
  const privateIdea: LifecycleItem = { ...idea, visibility: "private" };

  assert.deepEqual(checkShare(privateIdea, author), { ok: true });
  assert.equal(checkShare(privateIdea, planner).ok, false, "not the author -- not even a planner may share someone else's private item");
  assert.equal(checkShare(privateIdea, stranger).ok, false);

  assert.equal(checkShare(idea, author).ok, false, "already group -- nothing to share");

  const lockedPrivate: LifecycleItem = { ...idea, visibility: "private", status: "locked" };
  assert.equal(checkShare(lockedPrivate, author).ok, false, "must unlock first");
});
