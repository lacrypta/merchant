CREATE TABLE "coupon_discovery" (
	"owner_pubkey" varchar(64) PRIMARY KEY NOT NULL,
	"event" jsonb NOT NULL,
	"event_created_at" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
