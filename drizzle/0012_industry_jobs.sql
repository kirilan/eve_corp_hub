CREATE TABLE "character_blueprints" (
	"character_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"type_id" bigint NOT NULL,
	"material_efficiency" integer NOT NULL,
	"time_efficiency" integer NOT NULL,
	"runs" integer NOT NULL,
	"quantity" integer NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_blueprints_character_id_item_id_pk" PRIMARY KEY("character_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "industry_jobs" (
	"character_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"activity_id" integer NOT NULL,
	"blueprint_id" bigint NOT NULL,
	"blueprint_type_id" bigint NOT NULL,
	"product_type_id" bigint,
	"runs" integer NOT NULL,
	"licensed_runs" integer,
	"successful_runs" integer,
	"cost" numeric(20, 2),
	"status" text NOT NULL,
	"facility_id" bigint NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"completed_date" timestamp with time zone,
	CONSTRAINT "industry_jobs_character_id_job_id_pk" PRIMARY KEY("character_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "character_blueprints" ADD CONSTRAINT "character_blueprints_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industry_jobs" ADD CONSTRAINT "industry_jobs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;