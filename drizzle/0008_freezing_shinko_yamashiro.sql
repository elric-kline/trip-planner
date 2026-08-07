-- Hand-written data migration (drizzle-kit only generates the DDL below) --
-- carries forward every existing wake/sleep location and tour-destination
-- waypoint into trip_day_locations before the old columns/table holding
-- them are dropped, so a deployed trip's data survives this refactor
-- instead of silently going blank.

-- Existing wake locations.
INSERT INTO "trip_day_locations" ("day_id", "kind", "name", "lat", "lng", "position", "created_at", "updated_at")
SELECT "id", 'wake', "wake_location_name", "wake_location_lat", "wake_location_lng", 0, "created_at", "updated_at"
FROM "trip_days"
WHERE "wake_location_name" IS NOT NULL;--> statement-breakpoint

-- Existing sleep locations.
INSERT INTO "trip_day_locations" ("day_id", "kind", "name", "lat", "lng", "position", "created_at", "updated_at")
SELECT "id", 'sleep', "sleep_location_name", "sleep_location_lat", "sleep_location_lng", 0, "created_at", "updated_at"
FROM "trip_days"
WHERE "sleep_location_name" IS NOT NULL;--> statement-breakpoint

-- Existing tour-destination stops -- same id and position preserved, since
-- nothing else needs to change about how they're ordered.
INSERT INTO "trip_day_locations" ("id", "day_id", "kind", "name", "lat", "lng", "position", "created_at", "updated_at")
SELECT "id", "day_id", 'stop', "name", "lat", "lng", "position", "created_at", "created_at"
FROM "trip_day_waypoints";--> statement-breakpoint

-- Every migrated location defaults to including every current trip member --
-- the same "default all-in" behavior a freshly created location gets going
-- forward (see days.ts).
INSERT INTO "trip_day_location_members" ("location_id", "user_id")
SELECT "tdl"."id", "tm"."user_id"
FROM "trip_day_locations" "tdl"
JOIN "trip_days" "td" ON "td"."id" = "tdl"."day_id"
JOIN "trip_members" "tm" ON "tm"."trip_id" = "td"."trip_id";--> statement-breakpoint

DROP TABLE "trip_day_waypoints" CASCADE;--> statement-breakpoint
ALTER TABLE "trip_days" DROP COLUMN "wake_location_name";--> statement-breakpoint
ALTER TABLE "trip_days" DROP COLUMN "wake_location_lat";--> statement-breakpoint
ALTER TABLE "trip_days" DROP COLUMN "wake_location_lng";--> statement-breakpoint
ALTER TABLE "trip_days" DROP COLUMN "sleep_location_name";--> statement-breakpoint
ALTER TABLE "trip_days" DROP COLUMN "sleep_location_lat";--> statement-breakpoint
ALTER TABLE "trip_days" DROP COLUMN "sleep_location_lng";