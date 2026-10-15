CREATE TABLE "corporation_directors" (
	"user_id" uuid NOT NULL,
	"corporation_id" bigint NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporation_directors_user_id_corporation_id_pk" PRIMARY KEY("user_id","corporation_id")
);
--> statement-breakpoint
ALTER TABLE "corporation_directors" ADD CONSTRAINT "corporation_directors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporation_directors" ADD CONSTRAINT "corporation_directors_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporation_directors_corporation_idx" ON "corporation_directors" USING btree ("corporation_id");