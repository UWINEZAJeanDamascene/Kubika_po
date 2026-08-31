-- Trigram indexes for substring search.
--
-- Product/client/supplier search issues `ILIKE '%term%'` (Prisma `contains` with
-- mode: 'insensitive'). A leading wildcard makes a B-tree index unusable, so
-- every search was a sequential scan of the tenant's whole table. GIN + pg_trgm
-- is the index type that can serve a leading-wildcard ILIKE.
--
-- NOTE ON CONCURRENTLY: Prisma runs each migration inside a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run in one. These are therefore plain
-- CREATE INDEX statements, which take a brief write lock on the table. On a
-- large production table, apply the equivalent CONCURRENTLY statements by hand
-- during a quiet window instead, then mark this migration as applied with:
--   npx prisma migrate resolve --applied 20260831000001_search_trigram_indexes

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Products: name and sku are the columns the product search and the POS
-- lookup hit hardest. barcode is included because scans fall back to a
-- substring match when the exact/prefix match misses.
CREATE INDEX IF NOT EXISTS "products_name_trgm_idx"
  ON "products" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_sku_trgm_idx"
  ON "products" USING gin ("sku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_barcode_trgm_idx"
  ON "products" USING gin ("barcode" gin_trgm_ops);

-- Clients and suppliers: name is searched from pickers on nearly every
-- transactional form, and code is used for quick lookup.
CREATE INDEX IF NOT EXISTS "clients_name_trgm_idx"
  ON "clients" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "clients_code_trgm_idx"
  ON "clients" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "suppliers_name_trgm_idx"
  ON "suppliers" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "suppliers_code_trgm_idx"
  ON "suppliers" USING gin ("code" gin_trgm_ops);
