import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * A process-up check isn't enough here — the failure mode we care about is
 * "the app is running but can't reach the database," which is exactly what a
 * bare 200 from Next would hide. Railway's healthcheck gates traffic cutover
 * on this, so a container that can't reach the DB stays out of rotation
 * instead of serving 500s.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch (err) {
    return Response.json(
      { status: "error", message: (err as Error).message },
      { status: 503 },
    );
  }
}
