CREATE TABLE "ai_briefings" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "briefing_date" DATE NOT NULL,
  "summary" TEXT NOT NULL,
  "findings" JSONB NOT NULL DEFAULT '[]',
  "recommendations" JSONB NOT NULL DEFAULT '[]',
  "facts" JSONB NOT NULL DEFAULT '[]',
  "evidence_fact_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_briefings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_briefings_company_id_briefing_date_key"
  ON "ai_briefings"("company_id", "briefing_date");
CREATE INDEX "ai_briefings_company_id_briefing_date_idx"
  ON "ai_briefings"("company_id", "briefing_date" DESC);

CREATE TABLE "ai_finding_user_states" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  "finding_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "snoozed_until" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_finding_user_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_finding_user_states_company_user_finding_key"
  ON "ai_finding_user_states"("company_id", "user_id", "finding_id");
CREATE INDEX "ai_finding_user_states_company_user_state_snoozed_idx"
  ON "ai_finding_user_states"("company_id", "user_id", "state", "snoozed_until");

CREATE TABLE "ai_alert_daily_usage" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  "alert_date" DATE NOT NULL,
  "alert_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_alert_daily_usage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_alert_daily_usage_company_user_date_key"
  ON "ai_alert_daily_usage"("company_id", "user_id", "alert_date");

CREATE TABLE "ai_finding_alert_deliveries" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  "finding_id" TEXT NOT NULL,
  "alert_date" DATE NOT NULL,
  "notification_id" CHAR(24),
  "suppressed" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_finding_alert_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_finding_alert_deliveries_company_user_finding_date_key"
  ON "ai_finding_alert_deliveries"("company_id", "user_id", "finding_id", "alert_date");
CREATE INDEX "ai_finding_alert_deliveries_company_user_date_idx"
  ON "ai_finding_alert_deliveries"("company_id", "user_id", "alert_date");
