/**
 * Ensures the initial admin user exists. Safe to run on every deploy: it only
 * inserts when the row is missing, so it can never reset a password the admin
 * has since set, or flip isAdmin back if that ever changes by other means.
 *
 * There's no admin surface yet — this just seeds who a future one should
 * trust. The account has no password until its first magic-link sign-in,
 * which prompts for one (see lib/auth.ts's redeemLoginToken).
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { users } from "./schema.ts";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/trip_planner";

const ADMIN_EMAIL = "elric.m.kline@gmail.com";

async function main() {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql, { schema: { users } });

  try {
    const [created] = await db
      .insert(users)
      .values({ email: ADMIN_EMAIL, isAdmin: true })
      .onConflictDoNothing({ target: users.email })
      .returning();

    console.log(
      created
        ? `[seed] created admin user ${ADMIN_EMAIL} — no password set yet, first sign-in will prompt for one.`
        : `[seed] ${ADMIN_EMAIL} already exists, left untouched.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
