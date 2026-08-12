-- Match the product-list query: tenant + active/archive flags, ordered by
-- newest first.  This prevents a tenant-wide scan and sort as the catalogue
-- grows. PostgreSQL can also use these indexes for the corresponding count.
CREATE INDEX IF NOT EXISTS "products_company_active_archived_created_at_idx"
  ON "products" ("company_id", "is_active", "is_archived", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "products_company_archived_supplier_created_at_idx"
  ON "products" ("company_id", "is_archived", "supplier_id", "created_at" DESC);
