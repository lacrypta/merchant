CREATE TYPE "public"."coupon_mint_status" AS ENUM('minted', 'claimed');--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('percent', 'fixed', 'multibuy', 'buy_x_get_y');--> statement-breakpoint
CREATE TABLE "coupon_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_pubkey" varchar(64) NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"image_url" varchar(500),
	"type" "coupon_type" NOT NULL,
	"percent" integer,
	"amount" numeric(14, 2),
	"currency" varchar(3),
	"buy_qty" integer,
	"pay_qty" integer,
	"product_d" uuid,
	"buy_product_d" uuid,
	"gift_product_d" uuid,
	"max_uses" integer,
	"minted_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_minters" (
	"owner_pubkey" varchar(64) NOT NULL,
	"minter_pubkey" varchar(64) NOT NULL,
	"label" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_minters_owner_pubkey_minter_pubkey_pk" PRIMARY KEY("owner_pubkey","minter_pubkey")
);
--> statement-breakpoint
CREATE TABLE "coupon_mints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"definition_id" uuid NOT NULL,
	"nonce" varchar(32) NOT NULL,
	"benefit" jsonb NOT NULL,
	"minted_by_pubkey" varchar(64) NOT NULL,
	"minted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "coupon_mint_status" DEFAULT 'minted' NOT NULL,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "coupon_mints" ADD CONSTRAINT "coupon_mints_definition_id_coupon_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."coupon_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_definitions_owner_idx" ON "coupon_definitions" USING btree ("owner_pubkey");--> statement-breakpoint
CREATE INDEX "coupon_minters_minter_idx" ON "coupon_minters" USING btree ("minter_pubkey");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_mints_nonce_unique" ON "coupon_mints" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "coupon_mints_definition_idx" ON "coupon_mints" USING btree ("definition_id","status");