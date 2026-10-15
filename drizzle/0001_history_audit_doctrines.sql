CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_name" text NOT NULL,
	"corporation_id" bigint,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctrine_fittings" (
	"doctrine_id" uuid NOT NULL,
	"fitting_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctrine_fittings_doctrine_id_fitting_id_pk" PRIMARY KEY("doctrine_id","fitting_id")
);
--> statement-breakpoint
CREATE TABLE "doctrines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corporation_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fitting_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"ship_type_id" bigint NOT NULL,
	"items" jsonb NOT NULL,
	"source" text NOT NULL,
	"editor_id" uuid,
	"editor_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_super_user" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctrine_fittings" ADD CONSTRAINT "doctrine_fittings_doctrine_id_doctrines_id_fk" FOREIGN KEY ("doctrine_id") REFERENCES "public"."doctrines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctrine_fittings" ADD CONSTRAINT "doctrine_fittings_fitting_id_fittings_id_fk" FOREIGN KEY ("fitting_id") REFERENCES "public"."fittings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitting_versions" ADD CONSTRAINT "fitting_versions_fitting_id_fittings_id_fk" FOREIGN KEY ("fitting_id") REFERENCES "public"."fittings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitting_versions" ADD CONSTRAINT "fitting_versions_editor_id_users_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_corporation_at_idx" ON "audit_log" USING btree ("corporation_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "doctrine_fittings_fitting_idx" ON "doctrine_fittings" USING btree ("fitting_id");--> statement-breakpoint
CREATE INDEX "doctrines_corporation_idx" ON "doctrines" USING btree ("corporation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fitting_versions_fitting_version_idx" ON "fitting_versions" USING btree ("fitting_id","version");--> statement-breakpoint
-- Hand-written data steps: carry the old admin flag over, and give every existing fit a version 1
-- (its current contents, attributed to its owner) so history starts from what is there today.
UPDATE "users" SET "is_super_user" = "is_admin";--> statement-breakpoint
INSERT INTO "fitting_versions" ("fitting_id", "version", "name", "description", "ship_type_id", "items", "source", "editor_id", "editor_name", "created_at")
SELECT f."id", 1, f."name", f."description", f."ship_type_id", f."items", 'created', f."owner_id", c."name", f."updated_at"
FROM "fittings" f
LEFT JOIN "users" u ON u."id" = f."owner_id"
LEFT JOIN "characters" c ON c."id" = u."main_character_id";
