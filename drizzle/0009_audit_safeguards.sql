ALTER TABLE "wallet_syncs" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_syncs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "eve_types_lower_name_idx" ON "eve_types" USING btree (lower("name"));