ALTER TABLE "stock_batches"
  ADD COLUMN "reserved_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE "project_material_requisition_lines"
  ADD COLUMN "tracking_allocations" JSONB NOT NULL DEFAULT '[]'::jsonb;
