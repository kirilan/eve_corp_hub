CREATE TABLE "cron_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"result" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "cron_runs_job_started_idx" ON "cron_runs" USING btree ("job","started_at");