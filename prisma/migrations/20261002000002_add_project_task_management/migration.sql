ALTER TABLE "projects"
  ADD COLUMN "estimated_hours" DECIMAL(9,2) NOT NULL DEFAULT 0,
  ADD COLUMN "actual_hours" DECIMAL(9,2) NOT NULL DEFAULT 0,
  ADD COLUMN "acceptance_criteria" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "depends_on_ids" CHAR(24)[] NOT NULL DEFAULT ARRAY[]::CHAR(24)[],
  ADD COLUMN "completed_at" TIMESTAMPTZ(3);
