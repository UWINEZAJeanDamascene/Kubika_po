CREATE TABLE "ai_forecasts" (
  "id" CHAR(24) NOT NULL,
  "forecast_id" TEXT NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "created_by" CHAR(24) NOT NULL,
  "forecast_type" TEXT NOT NULL,
  "date_range" JSONB NOT NULL,
  "horizon" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "forecast" JSONB NOT NULL,
  "assumptions" JSONB NOT NULL DEFAULT '[]',
  "source_facts" JSONB NOT NULL DEFAULT '[]',
  "backtest_metrics" JSONB NOT NULL DEFAULT '{}',
  "model_version" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_forecasts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_forecasts_company_id_forecast_id_key"
  ON "ai_forecasts"("company_id", "forecast_id");
CREATE INDEX "ai_forecasts_company_type_created_at_idx"
  ON "ai_forecasts"("company_id", "forecast_type", "created_at" DESC);
