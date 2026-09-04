CREATE TABLE "import_templates" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "entity_type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "column_mapping" JSONB NOT NULL DEFAULT '{}',
  "created_by" CHAR(24) NOT NULL,
  "last_used_at" TIMESTAMPTZ(3),
  "use_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_templates_company_entity_name_key" ON "import_templates"("company_id", "entity_type", "name");
CREATE INDEX "import_templates_company_entity_idx" ON "import_templates"("company_id", "entity_type");

CREATE TABLE "import_logs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "entity_type" TEXT NOT NULL,
  "imported_by" CHAR(24) NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  "status" TEXT NOT NULL DEFAULT 'pending',
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "success_rows" INTEGER NOT NULL DEFAULT 0,
  "error_rows" INTEGER NOT NULL DEFAULT 0,
  "skipped_rows" INTEGER NOT NULL DEFAULT 0,
  "template_used" CHAR(24),
  "error_report_url" TEXT,
  "results_report_url" TEXT,
  "file_name" TEXT NOT NULL,
  "job_id" TEXT,
  "row_outcomes" JSONB NOT NULL DEFAULT '[]',
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_logs_company_entity_started_idx" ON "import_logs"("company_id", "entity_type", "started_at");
CREATE INDEX "import_logs_job_id_idx" ON "import_logs"("job_id");
