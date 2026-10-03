CREATE TABLE "pos_held_sales" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "created_by_id" CHAR(24) NOT NULL,
  "label" TEXT NOT NULL,
  "sale_data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_held_sales_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_held_sales_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_held_sales_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "pos_held_sales_company_id_created_at_idx" ON "pos_held_sales"("company_id", "created_at");
