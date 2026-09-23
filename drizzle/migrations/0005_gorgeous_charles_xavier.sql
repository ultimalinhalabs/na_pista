CREATE TABLE "na_pista"."professionals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"phone" text,
	"email" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "na_pista"."professional_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Manually reordered ahead of the FK ALTER TABLE statements below — same
-- drizzle-kit generation-ordering bug already documented in F20/F22/F23's
-- migrations (the generator emits FK constraints referencing a composite
-- unique index before the CREATE UNIQUE INDEX that creates it, when both
-- are new in the same migration; Postgres requires the referenced unique
-- constraint to exist first).
CREATE UNIQUE INDEX "professionals_org_id_unique" ON "na_pista"."professionals" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_org_id_unique" ON "na_pista"."services" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "na_pista"."professional_services" ADD CONSTRAINT "professional_services_professional_org_fk" FOREIGN KEY ("organization_id","professional_id") REFERENCES "na_pista"."professionals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."professional_services" ADD CONSTRAINT "professional_services_service_org_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "na_pista"."services"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "professionals_org_created_idx" ON "na_pista"."professionals" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "professionals_org_status_idx" ON "na_pista"."professionals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_services_org_prof_service_unique" ON "na_pista"."professional_services" USING btree ("organization_id","professional_id","service_id");--> statement-breakpoint
CREATE INDEX "professional_services_org_professional_idx" ON "na_pista"."professional_services" USING btree ("organization_id","professional_id");
