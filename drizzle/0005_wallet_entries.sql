CREATE TABLE "wallet_entries" (
	"character_id" bigint NOT NULL,
	"journal_id" bigint NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"ref_type" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"tax" numeric(20, 2) DEFAULT 0 NOT NULL,
	"solar_system_id" bigint,
	CONSTRAINT "wallet_entries_character_id_journal_id_pk" PRIMARY KEY("character_id","journal_id")
);
--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_entries_character_date_idx" ON "wallet_entries" USING btree ("character_id","date");--> statement-breakpoint
INSERT INTO "wallet_entries" SELECT "character_id", "journal_id", "date", "ref_type", "amount", "tax", "solar_system_id" FROM "ratting_entries" ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Synced history held ratting lines only: the next sync re-reads 30 days and history counts from there.
UPDATE "wallet_syncs" SET "history_from" = NULL, "attempted_at" = 'epoch';
