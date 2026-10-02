ALTER TABLE "payroll_runs"
ADD COLUMN "compliance" JSONB NOT NULL DEFAULT '{}'::jsonb;
