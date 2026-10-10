ALTER TABLE "project_milestones"
ADD COLUMN "task_ids" CHAR(24)[] NOT NULL DEFAULT ARRAY[]::CHAR(24)[];
