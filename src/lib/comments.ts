import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { itemComments, users } from "@/db/schema";
import { getItem, type TripAccess } from "./scope.ts";
import { RuleError } from "./items.ts";

export type ItemComment = {
  id: string;
  itemId: string;
  userId: string;
  authorName: string | null;
  authorEmail: string;
  body: string;
  createdAt: Date;
};

const MAX_BODY = 2000;

/**
 * An item's discussion, oldest first.
 *
 * `getItem` is the access check and the only one needed: it already refuses an
 * item the viewer can't see (see scope.ts's visibleToViewer), so a comment
 * thread inherits exactly the item's own visibility rather than carrying a
 * second, parallel rule that could drift out of step with it.
 */
export async function listComments(access: TripAccess, itemId: string): Promise<ItemComment[]> {
  await getItem(access, itemId);

  const rows = await db
    .select({
      id: itemComments.id,
      itemId: itemComments.itemId,
      userId: itemComments.userId,
      body: itemComments.body,
      createdAt: itemComments.createdAt,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(itemComments)
    .innerJoin(users, eq(users.id, itemComments.userId))
    .where(eq(itemComments.itemId, itemId))
    .orderBy(asc(itemComments.createdAt));

  return rows;
}

/** Any member who can see the item can comment on it -- discussion isn't a privilege. */
export async function addComment(
  access: TripAccess,
  itemId: string,
  body: string,
): Promise<ItemComment> {
  await getItem(access, itemId);

  const trimmed = body.trim();
  if (!trimmed) throw new RuleError("Write something first.");
  if (trimmed.length > MAX_BODY) {
    throw new RuleError(`Keep it under ${MAX_BODY} characters.`);
  }

  const [created] = await db
    .insert(itemComments)
    .values({ itemId, userId: access.viewer.id, body: trimmed })
    .returning();

  return {
    ...created,
    authorName: access.viewer.name,
    authorEmail: access.viewer.email,
  };
}

/**
 * Its author, or a planner. A planner needs it to clear something posted in
 * anger or by mistake; nobody else gets to edit the record of what was said.
 */
export async function deleteComment(access: TripAccess, commentId: string): Promise<void> {
  const [comment] = await db
    .select()
    .from(itemComments)
    .where(eq(itemComments.id, commentId))
    .limit(1);
  if (!comment) throw new RuleError("That comment is already gone.");

  // Re-checks item visibility, so a comment id from another trip can't be
  // deleted by guessing it.
  await getItem(access, comment.itemId);

  if (comment.userId !== access.viewer.id && !access.isPlanner) {
    throw new RuleError("Only its author, or a planner, can delete a comment.");
  }

  await db.delete(itemComments).where(and(eq(itemComments.id, commentId)));
}
