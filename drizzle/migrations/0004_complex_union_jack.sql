CREATE TABLE "na_pista"."services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration_minutes" integer NOT NULL,
	"price" numeric(14, 2),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_duration_minutes_positive" CHECK ("na_pista"."services"."duration_minutes" > 0),
	CONSTRAINT "services_price_non_negative" CHECK ("na_pista"."services"."price" IS NULL OR "na_pista"."services"."price" >= 0)
);
--> statement-breakpoint
CREATE INDEX "services_org_created_idx" ON "na_pista"."services" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "services_org_status_idx" ON "na_pista"."services" USING btree ("organization_id","status");