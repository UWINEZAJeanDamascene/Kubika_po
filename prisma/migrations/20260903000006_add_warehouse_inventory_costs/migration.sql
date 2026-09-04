CREATE TABLE "warehouse_inventory_costs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "warehouse_id" CHAR(24) NOT NULL,
  "product_id" CHAR(24) NOT NULL,
  "total_qty" DECIMAL(19,6) NOT NULL DEFAULT 0,
  "total_value" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_inventory_costs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_inventory_costs_company_warehouse_product_key" ON "warehouse_inventory_costs"("company_id", "warehouse_id", "product_id");
CREATE INDEX "warehouse_inventory_costs_company_warehouse_idx" ON "warehouse_inventory_costs"("company_id", "warehouse_id");
CREATE INDEX "warehouse_inventory_costs_company_product_idx" ON "warehouse_inventory_costs"("company_id", "product_id");
