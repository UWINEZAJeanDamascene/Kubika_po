CREATE TABLE "project_milestones" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "project_id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "assignee_id" CHAR(24),
  "status" TEXT NOT NULL DEFAULT 'planned',
  "priority" TEXT NOT NULL DEFAULT 'medium',
  "due_date" TIMESTAMPTZ(3),
  "progress_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "depends_on_ids" CHAR(24)[] NOT NULL DEFAULT ARRAY[]::CHAR(24)[],
  "completed_at" TIMESTAMPTZ(3),
  "created_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_milestones_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_milestones_company_id_project_id_due_date_idx" ON "project_milestones"("company_id", "project_id", "due_date");
CREATE INDEX "project_milestones_company_id_status_idx" ON "project_milestones"("company_id", "status");