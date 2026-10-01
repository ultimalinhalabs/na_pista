CREATE TABLE "na_pista"."organization_platform_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform_api_key_id" uuid NOT NULL,
	"encrypted_credential" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_platform_credentials_status_valid" CHECK ("na_pista"."organization_platform_credentials"."status" IN ('ACTIVE', 'REVOKED')),
	CONSTRAINT "org_platform_credentials_revoked_at_matches_status" CHECK (("na_pista"."organization_platform_credentials"."status" = 'REVOKED') = ("na_pista"."organization_platform_credentials"."revoked_at" IS NOT NULL)),
	CONSTRAINT "org_platform_credentials_envelope_versioned" CHECK ("na_pista"."organization_platform_credentials"."encrypted_credential" LIKE 'v1:%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "org_platform_credentials_one_active_per_org" ON "na_pista"."organization_platform_credentials" USING btree ("organization_id") WHERE "na_pista"."organization_platform_credentials"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "org_platform_credentials_platform_api_key_id_unique" ON "na_pista"."organization_platform_credentials" USING btree ("platform_api_key_id");--> statement-breakpoint
CREATE INDEX "org_platform_credentials_org_created_idx" ON "na_pista"."organization_platform_credentials" USING btree ("organization_id","created_at");