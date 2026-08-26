CREATE TYPE "public"."schedule_finding_reason" AS ENUM('overlap', 'travel', 'no-location');--> statement-breakpoint
CREATE TYPE "public"."schedule_finding_severity" AS ENUM('tight', 'conflict');--> statement-breakpoint
CREATE TABLE "timeline_finding_dismissals" (
	"before_item_id" uuid NOT NULL,
	"after_item_id" uuid NOT NULL,
	"reason" "schedule_finding_reason" NOT NULL,
	"severity" "schedule_finding_severity" NOT NULL,
	"user_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_finding_dismissals_before_item_id_after_item_id_reason_severity_user_id_pk" PRIMARY KEY("before_item_id","after_item_id","reason","severity","user_id")
);
--> statement-breakpoint
ALTER TABLE "timeline_finding_dismissals" ADD CONSTRAINT "timeline_finding_dismissals_before_item_id_items_id_fk" FOREIGN KEY ("before_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_finding_dismissals" ADD CONSTRAINT "timeline_finding_dismissals_after_item_id_items_id_fk" FOREIGN KEY ("after_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_finding_dismissals" ADD CONSTRAINT "timeline_finding_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timeline_finding_dismissals_user_idx" ON "timeline_finding_dismissals" USING btree ("user_id");