CREATE TABLE "precomputed_aggregations" (
  "id" CHAR(24) NOT NULL,
  "company" CHAR(24) NOT NULL,
  "type" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "as_of_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "data" JSONB NOT NULL,
  "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "computation_time_ms" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'success',
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "precomputed_aggregations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "precomputed_aggregations_company_type_period_idx" ON "precomputed_aggregations"("company", "type", "period");
CREATE INDEX "precomputed_aggregations_company_type_as_of_date_idx" ON "precomputed_aggregations"("company", "type", "as_of_date");
