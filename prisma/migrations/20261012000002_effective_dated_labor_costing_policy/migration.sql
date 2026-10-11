CREATE TABLE "labor_costing_policies" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "effective_from" DATE NOT NULL,
  "basis" TEXT NOT NULL,
  "standard_weekly_hours" DECIMAL(7,2) NOT NULL,
  "role_rates" JSONB NOT NULL DEFAULT '{}',
  "actor_user_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "labor_costing_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "labor_costing_policies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "labor_costing_policies_company_id_effective_from_created_at_idx"
  ON "labor_costing_policies"("company_id", "effective_from" DESC, "created_at" DESC);

INSERT INTO "labor_costing_policies" (
  "id",
  "company_id",
  "effective_from",
  "basis",
  "standard_weekly_hours",
  "role_rates",
  "actor_user_id"
)
SELECT
  SUBSTRING(MD5("company_id" || ':initial-labor-policy') FROM 1 FOR 24),
  "company_id",
  DATE '1900-01-01',
  "labor_costing_basis",
  "labor_standard_hours_per_week",
  "labor_cost_role_rates",
  "last_updated_by"
FROM "system_settings";
