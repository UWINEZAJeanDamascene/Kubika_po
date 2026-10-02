CREATE TABLE "project_labor_entries" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "project_id" CHAR(24) NOT NULL,
  "task_id" CHAR(24) NOT NULL,
  "timesheet_id" CHAR(24) NOT NULL,
  "employee_id" CHAR(24) NOT NULL,
  "line_index" INTEGER NOT NULL,
  "entry_date" DATE NOT NULL,
  "hours" DECIMAL(9,2) NOT NULL,
  "hourly_rate" DECIMAL(19,4) NOT NULL,
  "labor_cost" DECIMAL(19,2) NOT NULL,
  "currency_code" VARCHAR(3) NOT NULL,
  "activity_type" TEXT NOT NULL,
  "notes" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_labor_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_labor_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_labor_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_labor_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_labor_entries_timesheet_id_fkey" FOREIGN KEY ("timesheet_id") REFERENCES "timesheets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_labor_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_labor_entries_timesheet_id_line_index_key" ON "project_labor_entries"("timesheet_id", "line_index");
CREATE INDEX "project_labor_entries_company_id_project_id_entry_date_idx" ON "project_labor_entries"("company_id", "project_id", "entry_date");
CREATE INDEX "project_labor_entries_company_id_task_id_entry_date_idx" ON "project_labor_entries"("company_id", "task_id", "entry_date");