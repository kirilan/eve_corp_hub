CREATE TABLE "pvp_crawls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crawled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pvp_fits" (
	"crawl_id" bigint NOT NULL,
	"killmail_id" bigint NOT NULL,
	"character_id" bigint NOT NULL,
	"ship_type_id" bigint NOT NULL,
	"name" text NOT NULL,
	"items" jsonb NOT NULL,
	"losses" integer NOT NULL,
	"lost_at" timestamp with time zone NOT NULL,
	"solar_system_id" bigint NOT NULL,
	"value" real,
	CONSTRAINT "pvp_fits_crawl_id_killmail_id_pk" PRIMARY KEY("crawl_id","killmail_id")
);
--> statement-breakpoint
CREATE TABLE "pvp_pilots" (
	"crawl_id" bigint NOT NULL,
	"character_id" bigint NOT NULL,
	"rank" integer NOT NULL,
	"name" text NOT NULL,
	"corporation_id" bigint,
	"alliance_id" bigint,
	"losses" integer NOT NULL,
	CONSTRAINT "pvp_pilots_crawl_id_character_id_pk" PRIMARY KEY("crawl_id","character_id")
);
--> statement-breakpoint
ALTER TABLE "pvp_fits" ADD CONSTRAINT "pvp_fits_crawl_id_pvp_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."pvp_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pvp_fits" ADD CONSTRAINT "pvp_fits_crawl_id_character_id_pvp_pilots_crawl_id_character_id_fk" FOREIGN KEY ("crawl_id","character_id") REFERENCES "public"."pvp_pilots"("crawl_id","character_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pvp_pilots" ADD CONSTRAINT "pvp_pilots_crawl_id_pvp_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."pvp_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pvp_crawls_crawled_at_idx" ON "pvp_crawls" USING btree ("crawled_at");--> statement-breakpoint
CREATE INDEX "pvp_fits_killmail_idx" ON "pvp_fits" USING btree ("killmail_id");