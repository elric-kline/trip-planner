CREATE TYPE "public"."lodging_payment_status" AS ENUM('prepaid', 'partial', 'pay_on_arrival');--> statement-breakpoint
CREATE TABLE "lodging_details" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"address" text,
	"check_in_instructions" text,
	"contact_name" text,
	"contact_phone" text,
	"contact_email" text,
	"confirmation_number" text,
	"booked_by" uuid,
	"payment_status" "lodging_payment_status",
	"booking_url" text,
	"cancellation_deadline" timestamp with time zone,
	"cost_amount" double precision,
	"cost_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lodging_details" ADD CONSTRAINT "lodging_details_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lodging_details" ADD CONSTRAINT "lodging_details_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;