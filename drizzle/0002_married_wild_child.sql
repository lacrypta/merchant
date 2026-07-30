ALTER TABLE "coupon_definitions" ADD COLUMN "product_ds" jsonb;--> statement-breakpoint
-- Hand-added: a "2x1 en <producto>" that already exists has to keep meaning
-- that once the column it lived in is gone (next migration).
UPDATE "coupon_definitions"
   SET "product_ds" = jsonb_build_array("product_d"::text)
 WHERE "product_d" IS NOT NULL;
