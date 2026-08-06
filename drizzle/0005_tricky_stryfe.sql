ALTER TYPE "public"."coupon_type" ADD VALUE 'free_items';--> statement-breakpoint
ALTER TABLE "coupon_definitions" ADD COLUMN "free_items" jsonb;