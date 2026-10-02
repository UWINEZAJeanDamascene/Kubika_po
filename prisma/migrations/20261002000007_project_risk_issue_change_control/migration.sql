CREATE TABLE "project_control_items" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "project_id" CHAR(24) NOT NULL,
    "task_id" CHAR(24),
    "type" TEXT NOT NULL,
    "reference_no" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "owner_id" CHAR(24),
    "due_date" TIMESTAMPTZ(3),
    "probability_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "impact_cost" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "impact_days" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "mitigation" TEXT NOT NULL DEFAULT '',
    "decision" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by_id" CHAR(24),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "project_control_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_control_items_company_id_reference_no_key" ON "project_control_items"("company_id", "reference_no");
CREATE INDEX "project_control_items_company_id_project_id_type_status_idx" ON "project_control_items"("company_id", "project_id", "type", "status");
CREATE INDEX "project_control_items_company_id_task_id_idx" ON "project_control_items"("company_id", "task_id");
