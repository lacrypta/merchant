ALTER TYPE "public"."coupon_mint_status" ADD VALUE 'voided';--> statement-breakpoint
ALTER TABLE "coupon_mints" ADD COLUMN "voided_at" timestamp with time zone;