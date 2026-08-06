ALTER TABLE "coupon_mints" ADD COLUMN "order_event" jsonb;--> statement-breakpoint
ALTER TABLE "coupon_mints" ADD COLUMN "order_id" varchar(64);--> statement-breakpoint
ALTER TABLE "coupon_mints" ADD COLUMN "amount_msat" integer;--> statement-breakpoint
CREATE INDEX "coupon_mints_order_idx" ON "coupon_mints" USING btree ("order_id");