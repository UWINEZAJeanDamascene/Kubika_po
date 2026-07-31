-- Add performance indexes for product queries
-- These indexes optimize the common filter patterns used in product listing and search

-- Composite index for the most common query: company + active + not archived
CREATE INDEX IF NOT EXISTS idx_products_company_active_archived ON products (company_id, is_active, is_archived);

-- Composite index for category filtering on active products
CREATE INDEX IF NOT EXISTS idx_products_company_category_active ON products (company_id, category_id, is_active);

-- Index for product details page (latest stock movement lookup)
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_company ON stock_movements (company_id, product_id, movement_date DESC);
