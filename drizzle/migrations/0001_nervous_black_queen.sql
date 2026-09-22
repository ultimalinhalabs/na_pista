CREATE TABLE "na_pista"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"notes" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "customers_org_created_idx" ON "na_pista"."customers" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "customers_org_status_idx" ON "na_pista"."customers" USING btree ("organization_id","status");