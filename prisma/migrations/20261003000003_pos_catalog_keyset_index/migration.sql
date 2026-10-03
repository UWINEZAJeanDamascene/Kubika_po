CREATE INDEX IF NOT EXISTS "products_company_active_name_id_idx"
ON "products" ("company_id", "is_active", "name", "id");
