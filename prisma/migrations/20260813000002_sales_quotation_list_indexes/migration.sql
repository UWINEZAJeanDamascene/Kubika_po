-- Faster list sorts for quotations and sales orders
CREATE INDEX IF NOT EXISTS "quotations_company_id_created_at_idx"
  ON "quotations"("company_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "quotations_company_id_quotation_date_idx"
  ON "quotations"("company_id", "quotation_date" DESC);

CREATE INDEX IF NOT EXISTS "sales_orders_company_id_created_at_idx"
  ON "sales_orders"("company_id", "created_at" DESC);
