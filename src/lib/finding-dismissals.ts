import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { timelineFindingDismissals } from "@/db/schema.ts";
import { findingKey, type FindingRef } from "./conflicts.ts";
import type { TripAccess } from "./scope.ts";

/**
 * Records that this viewer has looked at this finding and it's fine as-is --
 * e.g. a "tight" gap between a garden tour and a dinner on the same
 * property, where the real slack isn't travel time at all. See
 * conflicts.ts's FindingRef for what identifies "this finding."
 *
 * Idempotent: dismissing an already-dismissed finding is a no-op, not an
 * error -- the composite primary key means a second insert would otherwise
 * fail for no reason a caller should have to guard against.
 */
export async function dismissFinding(access: TripAccess, ref: FindingRef): Promise<void> {
  await db
    .insert(timelineFindingDismissals)
    .values({ ...ref, userId: access.viewer.id })
    .onConflictDoNothing();
}

/** Undoes dismissFinding -- brings the warning back for this viewer. A no-op if it wasn't dismissed. */
export async function undismissFinding(access: TripAccess, ref: FindingRef): Promise<void> {
  await db
    .delete(timelineFindingDismissals)
    .where(
      and(
        eq(timelineFindingDismissals.beforeItemId, ref.beforeItemId),
        eq(timelineFindingDismissals.afterItemId, ref.afterItemId),
        eq(timelineFindingDismissals.reason, ref.reason),
        eq(timelineFindingDismissals.severity, ref.severity),
        eq(timelineFindingDismissals.userId, access.viewer.id),
      ),
    );
}

/**
 * Every finding key (see conflicts.ts's findingKey) this viewer has
 * dismissed -- what conflicts-for.ts's timelineFindingsForViewer filters
 * flagged() findings against.
 */
export async function dismissedFindingKeysForViewer(access: TripAccess): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(timelineFindingDismissals)
    .where(eq(timelineFindingDismissals.userId, access.viewer.id));
  return new Set(rows.map((r) => findingKey(r)));
}
