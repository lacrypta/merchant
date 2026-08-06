ALTER TABLE "coupon_definitions" ADD COLUMN "cap_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "coupon_definitions" ADD COLUMN "cap_currency" varchar(3);