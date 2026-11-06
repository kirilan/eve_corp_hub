CREATE TABLE "market_history" (
	"region_id" bigint NOT NULL,
	"type_id" bigint NOT NULL,
	"volume" real NOT NULL,
	"average" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_history_region_id_type_id_pk" PRIMARY KEY("region_id","type_id")
);
