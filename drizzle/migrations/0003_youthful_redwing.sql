CREATE TABLE "na_pista"."order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("na_pista"."order_items"."quantity" > 0),
	CONSTRAINT "order_items_unit_price_non_negative" CHECK ("na_pista"."order_items"."unit_price" >= 0),
	CONSTRAINT "order_items_subtotal_non_negative" CHECK ("na_pista"."order_items"."subtotal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "na_pista"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" text NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_subtotal_non_negative" CHECK ("na_pista"."orders"."subtotal" >= 0),
	CONSTRAINT "orders_total_non_negative" CHECK ("na_pista"."orders"."total" >= 0),
	CONSTRAINT "orders_currency_shape" CHECK ("na_pista"."orders"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "na_pista"."products" ADD COLUMN "price" numeric(14, 2);--> statement-breakpoint
-- Manually reordered ahead of the FK ALTER TABLE statements below — same
-- drizzle-kit generation-ordering bug already documented in F20's and
-- F22's migrations (the generator emits FK constraints referencing a
-- composite unique index before the CREATE UNIQUE INDEX that creates it,
-- when both are new in the same migration; Postgres requires the
-- referenced unique constraint to exist first).
CREATE UNIQUE INDEX "orders_org_id_unique" ON "na_pista"."orders" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_id_unique" ON "na_pista"."customers" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "na_pista"."order_items" ADD CONSTRAINT "order_items_order_org_fk" FOREIGN KEY ("organization_id","order_id") REFERENCES "na_pista"."orders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."order_items" ADD CONSTRAINT "order_items_product_org_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "na_pista"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "na_pista"."orders" ADD CONSTRAINT "orders_customer_org_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "na_pista"."customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_items_org_order_idx" ON "na_pista"."order_items" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE INDEX "orders_org_created_idx" ON "na_pista"."orders" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_org_status_idx" ON "na_pista"."orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "orders_org_customer_idx" ON "na_pista"."orders" USING btree ("organization_id","customer_id");--> statement-breakpoint
ALTER TABLE "na_pista"."products" ADD CONSTRAINT "products_price_non_negative" CHECK ("na_pista"."products"."price" IS NULL OR "na_pista"."products"."price" >= 0);
