CREATE TABLE "price_lists" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
    "created_by_id" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_lists_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "price_lists_company_id_name_key" ON "price_lists"("company_id", "name");
CREATE INDEX "price_lists_company_id_is_active_idx" ON "price_lists"("company_id", "is_active");

CREATE TABLE "price_list_items" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "price_list_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "price" DECIMAL(19,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_list_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "price_list_items_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "price_list_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "price_list_items_price_list_id_product_id_key" ON "price_list_items"("price_list_id", "product_id");
CREATE INDEX "price_list_items_company_id_price_list_id_idx" ON "price_list_items"("company_id", "price_list_id");
CREATE INDEX "price_list_items_company_id_product_id_idx" ON "price_list_items"("company_id", "product_id");

ALTER TABLE "warehouses" ADD COLUMN "price_list_id" CHAR(24);
ALTER TABLE "warehouses"
    ADD CONSTRAINT "warehouses_price_list_id_fkey"
    FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "warehouses_company_id_price_list_id_idx" ON "warehouses"("company_id", "price_list_id");
