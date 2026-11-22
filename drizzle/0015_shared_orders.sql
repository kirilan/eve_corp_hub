CREATE TABLE "shared_orders" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"orders" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "share_orders_with_corp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_orders" ADD CONSTRAINT "shared_orders_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;