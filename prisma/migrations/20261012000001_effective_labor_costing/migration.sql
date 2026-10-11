ALTER TABLE "system_settings"
  ADD COLUMN "labor_costing_basis" TEXT NOT NULL DEFAULT 'gross_salary',
  ADD COLUMN "labor_standard_hours_per_week" DECIMAL(7,2) NOT NULL DEFAULT 40,
  ADD COLUMN "labor_cost_role_rates" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "salary_histories"
  ADD COLUMN "agreed_weekly_hours" DECIMAL(7,2),
  ADD COLUMN "manual_hourly_rate" DECIMAL(19,4);

ALTER TABLE "project_labor_entries"
  ADD COLUMN "costing_snapshot" JSONB NOT NULL DEFAULT '{}';
