CREATE TYPE "public"."transport_subtype" AS ENUM('flight', 'train', 'drive', 'rideshare', 'other');--> statement-breakpoint
CREATE TABLE "transport_details" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"subtype" "transport_subtype" NOT NULL,
	"international" boolean,
	"confirmation_number" text,
	"booked_by" uuid,
	"booking_url" text,
	"cost_amount" double precision,
	"cost_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"leg_order" integer NOT NULL,
	"airline" text,
	"flight_number" text,
	"departure_airport" text,
	"arrival_airport" text,
	"departs_at" timestamp with time zone NOT NULL,
	"arrives_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transport_details" ADD CONSTRAINT "transport_details_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_details" ADD CONSTRAINT "transport_details_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transport_legs_item_order_idx" ON "transport_legs" USING btree ("item_id","leg_order");--> statement-breakpoint
CREATE INDEX "transport_legs_item_idx" ON "transport_legs" USING btree ("item_id");