CREATE TABLE "ratting_entries" (
	"character_id" bigint NOT NULL,
	"journal_id" bigint NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"ref_type" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"tax" numeric(20, 2) DEFAULT 0 NOT NULL,
	"solar_system_id" bigint,
	CONSTRAINT "ratting_entries_character_id_journal_id_pk" PRIMARY KEY("character_id","journal_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_syncs" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"history_from" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "ratting_entries" ADD CONSTRAINT "ratting_entries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_syncs" ADD CONSTRAINT "wallet_syncs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ratting_entries_character_date_idx" ON "ratting_entries" USING btree ("character_id","date");