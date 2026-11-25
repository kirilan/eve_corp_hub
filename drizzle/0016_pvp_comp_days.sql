CREATE TABLE "pvp_comp_days" (
	"day" date PRIMARY KEY NOT NULL,
	"killmails" integer NOT NULL,
	"reported" integer,
	"kept" integer NOT NULL,
	"version" integer NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL
);
