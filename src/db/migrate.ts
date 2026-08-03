/**
 * Runs pending migrations, then exits. Intended to run once at container
 * start, immediately before the server binds a port — see package.json's
 * `start` script.
 *
 * Why start-time and not build-time: a platform's Postgres add-on can still be
 * provisioning when the app image builds, so a migration step wired into the
 * build has no guarantee the database exists yet. Start-time is different —
 * by the time this container is asked to serve traffic, the database is
 * expected to be up — but "expected" isn't "guaranteed" (a fresh add-on can
 * still be a few seconds from accepting connections), so this retries with
 * backoff instead of failing on the first connection attempt.
 *
 * If the database is genuinely down, this exits non-zero after the retry
 * budget so the platform's restart policy — not a silent skip — is what
 * handles it. See railway.json for the paired restart policy.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/trip_planner";

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDatabase(sql: postgres.Sql): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sql`select 1`;
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.log(
        `[migrate] database not reachable yet (attempt ${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message}. Retrying in ${delay}ms…`,
      );
      await sleep(delay);
    }
  }
}

async function main() {
  // A single connection, not the app's pool — this process runs once and exits.
  const sql = postgres(connectionString, { max: 1 });

  try {
    console.log("[migrate] waiting for database…");
    await waitForDatabase(sql);

    console.log("[migrate] running pending migrations…");
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });

    console.log("[migrate] up to date.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
