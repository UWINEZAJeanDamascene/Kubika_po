CREATE TABLE "payroll_period_inputs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "employee_id" CHAR(24) NOT NULL,
  "period_month" INTEGER NOT NULL,
  "period_year" INTEGER NOT NULL,
  "scheduled_days" DECIMAL(9,2) NOT NULL,
  "worked_days" DECIMAL(9,2) NOT NULL DEFAULT 0,
  "paid_leave_days" DECIMAL(9,2) NOT NULL DEFAULT 0,
  "unpaid_leave_days" DECIMAL(9,2) NOT NULL DEFAULT 0,
  "additional_income" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "deductions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "notes" TEXT,
  "entered_by_id" CHAR(24),
  "approved_by_id" CHAR(24),
  "approved_at" TIMESTAMPTZ(3),
  "applied_payroll_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "payroll_period_inputs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payroll_period_inputs_company_id_employee_id_period_year_period_month_key"
  ON "payroll_period_inputs"("company_id", "employee_id", "period_year", "period_month");
CREATE INDEX "payroll_period_inputs_company_id_period_year_period_month_status_idx"
  ON "payroll_period_inputs"("company_id", "period_year", "period_month", "status");
