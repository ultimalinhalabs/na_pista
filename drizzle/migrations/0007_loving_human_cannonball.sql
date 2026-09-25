CREATE TABLE "na_pista"."appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"service_name" text NOT NULL,
	"service_price" numeric(14, 2),
	"currency" text NOT NULL,
	"notes" text,
	"cancellation_reason" text,
	"canceled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_end_after_start" CHECK ("na_pista"."appointments"."end_at" > "na_pista"."appointments"."start_at"),
	CONSTRAINT "appointments_status_valid" CHECK ("na_pista"."appointments"."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELED')),
	CONSTRAINT "appointments_canceled_at_matches_status" CHECK (("na_pista"."appointments"."status" = 'CANCELED') = ("na_pista"."appointments"."canceled_at" IS NOT NULL)),
	CONSTRAINT "appointments_completed_at_matches_status" CHECK (("na_pista"."appointments"."status" = 'COMPLETED') = ("na_pista"."appointments"."completed_at" IS NOT NULL)),
	CONSTRAINT "appointments_cancellation_reason_only_when_canceled" CHECK ("na_pista"."appointments"."cancellation_reason" IS NULL OR "na_pista"."appointments"."status" = 'CANCELED'),
	CONSTRAINT "appointments_service_price_non_negative" CHECK ("na_pista"."appointments"."service_price" IS NULL OR "na_pista"."appointments"."service_price" >= 0),
	CONSTRAINT "appointments_currency_shape" CHECK ("na_pista"."appointments"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "na_pista"."appointments" ADD CONSTRAINT "appointments_customer_org_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "na_pista"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."appointments" ADD CONSTRAINT "appointments_professional_org_fk" FOREIGN KEY ("organization_id","professional_id") REFERENCES "na_pista"."professionals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."appointments" ADD CONSTRAINT "appointments_service_org_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "na_pista"."services"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_org_start_idx" ON "na_pista"."appointments" USING btree ("organization_id","start_at");--> statement-breakpoint
CREATE INDEX "appointments_org_professional_start_idx" ON "na_pista"."appointments" USING btree ("organization_id","professional_id","start_at");--> statement-breakpoint
CREATE INDEX "appointments_org_customer_start_idx" ON "na_pista"."appointments" USING btree ("organization_id","customer_id","start_at");