CREATE SCHEMA "na_pista";
--> statement-breakpoint
CREATE TABLE "na_pista"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "na_pista"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "na_pista"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_id_unique" ON "na_pista"."categories" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "categories_org_created_idx" ON "na_pista"."categories" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_id_unique" ON "na_pista"."products" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "products_org_created_idx" ON "na_pista"."products" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "products_org_category_idx" ON "na_pista"."products" USING btree ("organization_id","category_id");--> statement-breakpoint
CREATE INDEX "products_org_status_idx" ON "na_pista"."products" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "na_pista"."audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_resource_idx" ON "na_pista"."audit_events" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
-- Composite FK: a product can only ever reference a category that
-- belongs to the SAME organization (F20 brief §15) — moved after the
-- unique index it depends on; drizzle-kit generated it in the wrong
-- order (the referenced composite unique index must exist first).
ALTER TABLE "na_pista"."products" ADD CONSTRAINT "products_category_org_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "na_pista"."categories"("organization_id","id") ON DELETE no action ON UPDATE no action;