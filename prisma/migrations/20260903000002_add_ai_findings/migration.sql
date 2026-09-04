CREATE TABLE "ai_findings" (
  "id" CHAR(24) NOT NULL,
  "finding_id" TEXT NOT NULL,
  "company" CHAR(24) NOT NULL,
  "domain" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "evidence_fact_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recommended_next_step" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "first_detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_findings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_findings_company_finding_id_key" ON "ai_findings"("company", "finding_id");
CREATE INDEX "ai_findings_company_status_severity_idx" ON "ai_findings"("company", "status", "severity");
CREATE INDEX "ai_findings_company_domain_last_detected_at_idx" ON "ai_findings"("company", "domain", "last_detected_at");
