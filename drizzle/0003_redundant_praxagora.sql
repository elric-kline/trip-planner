CREATE TYPE "public"."dietary_tag" AS ENUM('vegetarian', 'vegan', 'pescatarian', 'gluten_free', 'dairy_free', 'nut_free', 'shellfish_free', 'halal', 'kosher', 'low_carb');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dietary_restrictions" "dietary_tag"[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dietary_notes" text;