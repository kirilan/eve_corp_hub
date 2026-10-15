CREATE TYPE "public"."fitting_visibility" AS ENUM('private', 'corporation', 'link', 'public');--> statement-breakpoint
CREATE TABLE "characters" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_hash" text NOT NULL,
	"corporation_id" bigint,
	"alliance_id" bigint,
	"affiliation_checked_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"refresh_token_enc" text,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"token_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eve_types" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"group_id" integer NOT NULL,
	"category_id" integer,
	"slot" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fittings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ship_type_id" bigint NOT NULL,
	"items" jsonb NOT NULL,
	"visibility" "fitting_visibility" DEFAULT 'private' NOT NULL,
	"corporation_id" bigint,
	"share_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fittings_corporation_has_corp" CHECK ("fittings"."visibility" <> 'corporation' OR "fittings"."corporation_id" IS NOT NULL),
	CONSTRAINT "fittings_link_has_token" CHECK ("fittings"."visibility" <> 'link' OR "fittings"."share_token" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"main_character_id" bigint,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fittings" ADD CONSTRAINT "fittings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_user_idx" ON "characters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fittings_owner_idx" ON "fittings" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "fittings_corporation_idx" ON "fittings" USING btree ("corporation_id");--> statement-breakpoint
CREATE INDEX "fittings_ship_idx" ON "fittings" USING btree ("ship_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fittings_share_token_idx" ON "fittings" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");