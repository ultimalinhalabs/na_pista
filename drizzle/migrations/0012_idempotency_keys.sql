CREATE TABLE "na_pista"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_actor_type_valid" CHECK ("na_pista"."idempotency_keys"."actor_type" IN ('user', 'service')),
	CONSTRAINT "idempotency_keys_key_length" CHECK (char_length("na_pista"."idempotency_keys"."idempotency_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_unique" ON "na_pista"."idempotency_keys" USING btree ("organization_id","actor_type","actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "na_pista"."idempotency_keys" USING btree ("created_at");