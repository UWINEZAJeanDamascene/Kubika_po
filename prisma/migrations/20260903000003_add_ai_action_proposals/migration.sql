CREATE TABLE "ai_action_proposals" (
  "id" CHAR(24) NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "company" CHAR(24) NOT NULL,
  "created_by" CHAR(24) NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "evidence_fact_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source_recommendation_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source_finding_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "risk_level" TEXT NOT NULL,
  "approval_required_by_role" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approved_by" CHAR(24),
  "approved_at" TIMESTAMPTZ(3),
  "rejected_by" CHAR(24),
  "rejected_at" TIMESTAMPTZ(3),
  "rejection_reason" TEXT,
  "executed_by" CHAR(24),
  "executed_at" TIMESTAMPTZ(3),
  "execution_result" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_action_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_action_proposals_company_proposal_id_key" ON "ai_action_proposals"("company", "proposal_id");
CREATE INDEX "ai_action_proposals_company_status_updated_at_idx" ON "ai_action_proposals"("company", "status", "updated_at");
CREATE INDEX "ai_action_proposals_company_type_status_idx" ON "ai_action_proposals"("company", "type", "status");
