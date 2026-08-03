import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/trip_planner";

// Next dev reloads modules on every edit; without this the pool count climbs
// until Postgres starts refusing connections.
const globalForDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> };
const sql = globalForDb.__sql ?? postgres(connectionString, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.__sql = sql;

export const db = drizzle(sql, { schema });
export { schema };
