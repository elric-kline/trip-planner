CREATE TYPE "public"."dining_price_range" AS ENUM('$', '$$', '$$$', '$$$$');--> statement-breakpoint
CREATE TABLE "dining_details" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"place_id" text,
	"cuisine" text,
	"accommodates" "dietary_tag"[],
	"party_size" integer,
	"price_range" "dining_price_range",
	"reserved_by" uuid,
	"confirmation_number" text,
	"contact_phone" text,
	"reservation_url" text,
	"special_requests" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dining_details" ADD CONSTRAINT "dining_details_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_details" ADD CONSTRAINT "dining_details_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;