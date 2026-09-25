CREATE TABLE "ai_reports" (
  "id" CHAR(24) NOT NULL,
  "report_id" TEXT NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "created_by" CHAR(24) NOT NULL,
  "report_type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "date_range" JSONB NOT NULL,
  "executive_summary" TEXT NOT NULL,
  "findings" JSONB NOT NULL DEFAULT '[]',
  "evidence" JSONB NOT NULL DEFAULT '[]',
  "calculations" JSONB NOT NULL DEFAULT '[]',
  "recommendations" JSONB NOT NULL DEFAULT '[]',
  "missing_data_caveats" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "generated_by" JSONB NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_reports_company_id_report_id_key"
  ON "ai_reports"("company_id", "report_id");
CREATE INDEX "ai_reports_company_report_type_generated_at_idx"
  ON "ai_reports"("company_id", "report_type", "generated_at" DESC);
