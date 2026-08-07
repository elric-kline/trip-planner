CREATE TABLE "trip_day_waypoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"date" text NOT NULL,
	"wake_location_name" text,
	"wake_location_lat" double precision,
	"wake_location_lng" double precision,
	"sleep_location_name" text,
	"sleep_location_lat" double precision,
	"sleep_location_lng" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_day_waypoints" ADD CONSTRAINT "trip_day_waypoints_day_id_trip_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."trip_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_day_waypoints_day_idx" ON "trip_day_waypoints" USING btree ("day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_days_trip_date_idx" ON "trip_days" USING btree ("trip_id","date");--> statement-breakpoint
CREATE INDEX "trip_days_trip_idx" ON "trip_days" USING btree ("trip_id");