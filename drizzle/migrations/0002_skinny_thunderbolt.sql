CREATE TABLE "na_pista"."inventory_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_quantity_non_negative" CHECK ("na_pista"."inventory_balances"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "na_pista"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"reason" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_positive" CHECK ("na_pista"."stock_movements"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "na_pista"."products" ADD COLUMN "unit" text DEFAULT 'UNIT' NOT NULL;--> statement-breakpoint
-- Unique indexes moved before the FK constraints that depend on them
-- (drizzle-kit generated them in the wrong order — same class of issue
-- already hit and documented in migration 0000; the referenced unique
-- index must exist before a composite FK can reference it).
CREATE UNIQUE INDEX "inventory_balances_org_product_unique" ON "na_pista"."inventory_balances" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_balances_org_id_unique" ON "na_pista"."inventory_balances" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "inventory_balances_org_updated_idx" ON "na_pista"."inventory_balances" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "stock_movements_org_product_created_idx" ON "na_pista"."stock_movements" USING btree ("organization_id","product_id","created_at");--> statement-breakpoint
ALTER TABLE "na_pista"."inventory_balances" ADD CONSTRAINT "inventory_balances_product_org_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "na_pista"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."stock_movements" ADD CONSTRAINT "stock_movements_product_org_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "na_pista"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."stock_movements" ADD CONSTRAINT "stock_movements_inventory_org_fk" FOREIGN KEY ("organization_id","inventory_id") REFERENCES "na_pista"."inventory_balances"("organization_id","id") ON DELETE no action ON UPDATE no action;