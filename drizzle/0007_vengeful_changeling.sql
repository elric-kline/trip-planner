CREATE TYPE "public"."day_location_kind" AS ENUM('wake', 'sleep', 'stop');--> statement-breakpoint
CREATE TABLE "trip_day_location_members" (
	"location_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "trip_day_location_members_location_id_user_id_pk" PRIMARY KEY("location_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "trip_day_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_id" uuid NOT NULL,
	"kind" "day_location_kind" NOT NULL,
	"name" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_day_location_members" ADD CONSTRAINT "trip_day_location_members_location_id_trip_day_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."trip_day_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_day_location_members" ADD CONSTRAINT "trip_day_location_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_day_locations" ADD CONSTRAINT "trip_day_locations_day_id_trip_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."trip_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_day_location_members_user_idx" ON "trip_day_location_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trip_day_locations_day_idx" ON "trip_day_locations" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "trip_day_locations_day_kind_idx" ON "trip_day_locations" USING btree ("day_id","kind");