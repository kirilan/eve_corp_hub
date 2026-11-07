CREATE TABLE "pvp_ship_kills" (
	"crawl_id" bigint NOT NULL,
	"character_id" bigint NOT NULL,
	"ship_type_id" bigint NOT NULL,
	"kills" integer NOT NULL,
	"isk_destroyed" double precision NOT NULL,
	CONSTRAINT "pvp_ship_kills_crawl_id_character_id_ship_type_id_pk" PRIMARY KEY("crawl_id","character_id","ship_type_id")
);
--> statement-breakpoint
ALTER TABLE "pvp_ship_kills" ADD CONSTRAINT "pvp_ship_kills_crawl_id_character_id_pvp_pilots_crawl_id_character_id_fk" FOREIGN KEY ("crawl_id","character_id") REFERENCES "public"."pvp_pilots"("crawl_id","character_id") ON DELETE cascade ON UPDATE no action;