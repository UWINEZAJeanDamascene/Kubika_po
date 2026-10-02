CREATE TABLE "project_material_requisitions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "project_id" CHAR(24) NOT NULL,
    "requisition_no" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "required_date" TIMESTAMPTZ(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "requested_by_id" CHAR(24),
    "approved_by_id" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "project_material_requisitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_material_requisition_lines" (
    "id" CHAR(24) NOT NULL,
    "requisition_id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "project_id" CHAR(24) NOT NULL,
    "task_id" CHAR(24),
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "planned_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "reserved_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "issued_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "returned_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "project_material_requisition_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_material_requisitions_company_id_requisition_no_key" ON "project_material_requisitions"("company_id", "requisition_no");
CREATE INDEX "project_material_requisitions_company_id_project_id_status_idx" ON "project_material_requisitions"("company_id", "project_id", "status");
CREATE INDEX "project_material_requisition_lines_company_id_project_id_task_id_idx" ON "project_material_requisition_lines"("company_id", "project_id", "task_id");
CREATE INDEX "project_material_requisition_lines_company_id_product_id_warehouse_id_idx" ON "project_material_requisition_lines"("company_id", "product_id", "warehouse_id");
ALTER TABLE "project_material_requisition_lines" ADD CONSTRAINT "project_material_requisition_lines_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "project_material_requisitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
