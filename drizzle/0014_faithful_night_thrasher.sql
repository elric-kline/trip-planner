CREATE TABLE "passport_details" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name_encrypted" text,
	"passport_number_encrypted" text,
	"nationality_encrypted" text,
	"date_of_birth_encrypted" text,
	"expiry_date_encrypted" text,
	"photo_encrypted" text,
	"photo_mime_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passport_details" ADD CONSTRAINT "passport_details_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;