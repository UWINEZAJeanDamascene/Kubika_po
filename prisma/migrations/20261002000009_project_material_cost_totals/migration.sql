ALTER TABLE "project_material_requisition_lines"
  ADD COLUMN "issued_cost" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN "returned_cost" DECIMAL(19,2) NOT NULL DEFAULT 0;
