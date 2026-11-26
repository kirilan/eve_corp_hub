ALTER TABLE "pvp_comp_hull_losses" ADD COLUMN "under_500m" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pvp_comp_hull_losses" ADD COLUMN "under_200m" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pvp_comp_months" ADD COLUMN "cap" smallint DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "pvp_comp_months" DROP CONSTRAINT "pvp_comp_months_pkey";--> statement-breakpoint
ALTER TABLE "pvp_comp_months" ADD CONSTRAINT "pvp_comp_months_month_cap_pk" PRIMARY KEY("month","cap");
