CREATE TABLE "market_prices" (
	"location_id" bigint NOT NULL,
	"type_id" bigint NOT NULL,
	"buy" jsonb NOT NULL,
	"sell" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_prices_location_id_type_id_pk" PRIMARY KEY("location_id","type_id")
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"location_id" bigint PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reader_character_id" bigint,
	"orders" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_reader_character_id_characters_id_fk" FOREIGN KEY ("reader_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;