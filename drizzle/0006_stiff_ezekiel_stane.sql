ALTER TABLE "items" ADD COLUMN "day_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "day_position" double precision;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_day_id_trip_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."trip_days"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_day_idx" ON "items" USING btree ("day_id");