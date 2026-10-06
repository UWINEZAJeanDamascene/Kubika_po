ALTER TABLE "recurring_invoice_lines"
  ADD COLUMN IF NOT EXISTS "product_name" TEXT,
  ADD COLUMN IF NOT EXISTS "product_code" TEXT,
  ADD COLUMN IF NOT EXISTS "unit" TEXT,
  ADD COLUMN IF NOT EXISTS "tax_code" TEXT NOT NULL DEFAULT 'A';

UPDATE "recurring_invoice_lines" AS ril
SET "product_name" = p."name",
    "product_code" = p."sku",
    "unit" = p."unit",
    "tax_code" = p."tax_code"
FROM "products" AS p
WHERE ril."product_id" = p."id"
  AND (ril."product_name" IS NULL OR ril."product_code" IS NULL OR ril."unit" IS NULL OR ril."tax_code" = 'A');
