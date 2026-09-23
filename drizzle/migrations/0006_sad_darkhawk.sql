CREATE TABLE "na_pista"."organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "na_pista"."professional_schedule_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_local_time" time NOT NULL,
	"end_local_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_schedule_rules_day_of_week_range" CHECK ("na_pista"."professional_schedule_rules"."day_of_week" >= 0 AND "na_pista"."professional_schedule_rules"."day_of_week" <= 6),
	CONSTRAINT "professional_schedule_rules_end_after_start" CHECK ("na_pista"."professional_schedule_rules"."end_local_time" > "na_pista"."professional_schedule_rules"."start_local_time")
);
--> statement-breakpoint
CREATE TABLE "na_pista"."professional_schedule_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_local_time" time,
	"end_local_time" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_schedule_exceptions_interval_shape" CHECK (("na_pista"."professional_schedule_exceptions"."start_local_time" IS NULL AND "na_pista"."professional_schedule_exceptions"."end_local_time" IS NULL) OR ("na_pista"."professional_schedule_exceptions"."start_local_time" IS NOT NULL AND "na_pista"."professional_schedule_exceptions"."end_local_time" IS NOT NULL AND "na_pista"."professional_schedule_exceptions"."end_local_time" > "na_pista"."professional_schedule_exceptions"."start_local_time"))
);
--> statement-breakpoint
ALTER TABLE "na_pista"."professional_schedule_rules" ADD CONSTRAINT "professional_schedule_rules_professional_org_fk" FOREIGN KEY ("organization_id","professional_id") REFERENCES "na_pista"."professionals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."professional_schedule_exceptions" ADD CONSTRAINT "professional_schedule_exceptions_professional_org_fk" FOREIGN KEY ("organization_id","professional_id") REFERENCES "na_pista"."professionals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "professional_schedule_rules_org_professional_idx" ON "na_pista"."professional_schedule_rules" USING btree ("organization_id","professional_id");--> statement-breakpoint
CREATE INDEX "professional_schedule_exceptions_org_professional_date_idx" ON "na_pista"."professional_schedule_exceptions" USING btree ("organization_id","professional_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_schedule_exceptions_closed_marker_unique" ON "na_pista"."professional_schedule_exceptions" USING btree ("organization_id","professional_id","date") WHERE "na_pista"."professional_schedule_exceptions"."start_local_time" IS NULL;