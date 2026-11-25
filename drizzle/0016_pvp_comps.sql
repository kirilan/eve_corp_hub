CREATE TABLE "pvp_comp_days" (
	"day" date PRIMARY KEY NOT NULL,
	"killmails" integer NOT NULL,
	"reported" integer,
	"kept" integer NOT NULL,
	"version" integer NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"carry" jsonb
);
--> statement-breakpoint
CREATE TABLE "pvp_comp_fits" (
	"killmail_id" bigint PRIMARY KEY NOT NULL,
	"fight_id" bigint NOT NULL,
	"side" smallint NOT NULL,
	"day" date NOT NULL,
	"processed_day" date NOT NULL,
	"character_id" bigint NOT NULL,
	"ship_type_id" bigint NOT NULL,
	"items" jsonb NOT NULL,
	"loadout" text NOT NULL,
	"value" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pvp_comp_hull_losses" (
	"day" date NOT NULL,
	"ship_type_id" bigint NOT NULL,
	"losses" integer NOT NULL,
	"affordable" integer NOT NULL,
	CONSTRAINT "pvp_comp_hull_losses_day_ship_type_id_pk" PRIMARY KEY("day","ship_type_id")
);
--> statement-breakpoint
CREATE TABLE "pvp_comp_months" (
	"month" date PRIMARY KEY NOT NULL,
	"results" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pvp_comp_sides" (
	"fight_id" bigint NOT NULL,
	"side" smallint NOT NULL,
	"day" date NOT NULL,
	"processed_day" date NOT NULL,
	"system_id" bigint NOT NULL,
	"pilots" smallint NOT NULL,
	"enemies" smallint NOT NULL,
	"isk_killed" double precision NOT NULL,
	"isk_lost" double precision NOT NULL,
	"hulls" integer[] NOT NULL,
	CONSTRAINT "pvp_comp_sides_fight_id_side_pk" PRIMARY KEY("fight_id","side")
);
--> statement-breakpoint
CREATE INDEX "pvp_comp_fits_day_idx" ON "pvp_comp_fits" USING btree ("day");--> statement-breakpoint
CREATE INDEX "pvp_comp_fits_processed_idx" ON "pvp_comp_fits" USING btree ("processed_day");--> statement-breakpoint
CREATE INDEX "pvp_comp_sides_day_idx" ON "pvp_comp_sides" USING btree ("day");--> statement-breakpoint
CREATE INDEX "pvp_comp_sides_processed_idx" ON "pvp_comp_sides" USING btree ("processed_day");