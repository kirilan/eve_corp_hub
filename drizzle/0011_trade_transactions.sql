CREATE TABLE "trade_exclusions" (
	"user_id" uuid NOT NULL,
	"type_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_exclusions_user_id_type_id_pk" PRIMARY KEY("user_id","type_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"character_id" bigint NOT NULL,
	"transaction_id" bigint NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"type_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(20, 2) NOT NULL,
	"is_buy" boolean NOT NULL,
	"location_id" bigint NOT NULL,
	"client_id" bigint NOT NULL,
	"journal_ref_id" bigint NOT NULL,
	CONSTRAINT "wallet_transactions_character_id_transaction_id_pk" PRIMARY KEY("character_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD COLUMN "transaction_id" bigint;--> statement-breakpoint
ALTER TABLE "trade_exclusions" ADD CONSTRAINT "trade_exclusions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_transactions_character_date_idx" ON "wallet_transactions" USING btree ("character_id","date");