export type ItemStatus = "idea" | "proposed" | "locked" | "declined";
export type Visibility = "private" | "group";
export type Commitment = "required" | "optional";

/**
 * The subset of an item the transition rules care about. Keeping this narrow
 * lets the rules be unit-tested without a database.
 */
export type LifecycleItem = {
  status: ItemStatus;
  visibility: Visibility;
  commitment: Commitment | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type Actor = { isPlanner: boolean; isAuthor: boolean };

export type Check = { ok: true } | { ok: false; reason: string };

const ok: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

/**
 * Pinning an idea costs nothing and commits nobody, so anyone may do it.
 * The gate is at locking, where the group's time gets spent.
 */
export function checkPropose(item: LifecycleItem, actor: Actor, startsAt: Date | null): Check {
  if (item.status === "locked") return no("Unlock the item before changing its time.");
  if (item.status === "declined") return no("Restore the item before scheduling it.");
  if (!startsAt) return no("A proposal needs a start time.");
  if (!actor.isAuthor && !actor.isPlanner)
    return no("Only the person who pinned this, or a planner, can schedule it.");
  return ok;
}

/** Dropping the time sends a proposal back to the ideas tray. */
export function checkUnschedule(item: LifecycleItem, actor: Actor): Check {
  if (item.status !== "proposed") return no("Only proposals can be unscheduled.");
  if (!actor.isAuthor && !actor.isPlanner)
    return no("Only the person who proposed this, or a planner, can unschedule it.");
  return ok;
}

export function checkLock(
  item: LifecycleItem,
  actor: Actor,
  commitment: Commitment | null,
): Check {
  if (item.status === "locked") return no("This item is already locked.");
  if (item.status === "declined") return no("Restore the item before locking it.");
  if (!item.startsAt) return no("Give the item a time before locking it.");
  if (item.endsAt && item.startsAt >= item.endsAt)
    return no("The end time must come after the start time.");

  if (item.visibility === "private") {
    // A private plan is one person's business; it needs no planner and puts
    // nobody on the bus, so required/optional is meaningless for it.
    if (!actor.isAuthor) return no("Only its author can lock a private item.");
    if (commitment) return no("Private items don't take a required/optional setting.");
    return ok;
  }

  if (!actor.isPlanner) return no("Only a Master Planner can lock group items.");
  if (!commitment) return no("Choose whether this item is required or optional.");
  return ok;
}

export function checkUnlock(item: LifecycleItem, actor: Actor): Check {
  if (item.status !== "locked") return no("This item isn't locked.");
  if (item.visibility === "private")
    return actor.isAuthor ? ok : no("Only its author can unlock a private item.");
  return actor.isPlanner ? ok : no("Only a Master Planner can unlock group items.");
}

export function checkDecline(item: LifecycleItem, actor: Actor): Check {
  if (item.status === "declined") return no("This item is already declined.");
  if (item.status === "locked")
    return no("Unlock the item before declining it, so attendees are told.");
  if (!actor.isAuthor && !actor.isPlanner)
    return no("Only the person who added this, or a planner, can decline it.");
  return ok;
}

export function checkRestore(item: LifecycleItem, actor: Actor): Check {
  if (item.status !== "declined") return no("This item isn't declined.");
  if (!actor.isAuthor && !actor.isPlanner)
    return no("Only the person who added this, or a planner, can restore it.");
  return ok;
}

/** RSVPs are only meaningful on locked, optional, group items. */
export function checkRsvp(item: LifecycleItem): Check {
  if (item.status !== "locked") return no("You can only RSVP to locked items.");
  if (item.visibility === "private") return no("Private items have no RSVPs.");
  if (item.commitment === "required")
    return no("Required items are automatic — no RSVP needed.");
  return ok;
}

/**
 * Moves a Scratchpad item into PlaySpace. Author-only, deliberately not
 * openable by a planner the way editing content is (canEditItem) --
 * privacy is about who gets to expose someone's own note to the group,
 * and that call stays exclusively the author's. Locked items must be
 * unlocked first: a locked private item has no commitment (checkLock's
 * private branch forbids one), but a locked group item requires one, so
 * sharing a still-locked item would land it in a state the lock rules
 * themselves never allow reaching directly.
 */
export function checkShare(item: LifecycleItem, actor: Actor): Check {
  if (item.visibility === "group") return no("This item is already shared.");
  if (item.status === "locked") return no("Unlock the item before sharing it.");
  if (!actor.isAuthor) return no("Only the person who added this can share it.");
  return ok;
}

/** Where a restored or unlocked item lands: back to a proposal if it has a time. */
export function statusForTime(startsAt: Date | null): ItemStatus {
  return startsAt ? "proposed" : "idea";
}
