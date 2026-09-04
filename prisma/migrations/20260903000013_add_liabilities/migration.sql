CREATE TABLE "liabilities" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "reference_no" TEXT,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "lender_name" TEXT,
  "principal_amount" DECIMAL(19,4) NOT NULL,
  "outstanding_balance" DECIMAL(19,4) NOT NULL,
  "interest_rate_pct" DOUBLE PRECISION,
  "interest_method" TEXT NOT NULL DEFAULT 'simple',
  "duration_months" INTEGER,
  "liability_account_id" CHAR(24) NOT NULL,
  "interest_expense_account_id" CHAR(24),
  "start_date" TIMESTAMPTZ(3) NOT NULL,
  "end_date" TIMESTAMPTZ(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "transactions" JSONB NOT NULL DEFAULT '[]',
  "journal_entry_id" CHAR(24),
  "notes" TEXT,
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "liabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "liabilities_company_reference_no_key" ON "liabilities"("company_id", "reference_no");
CREATE INDEX "liabilities_company_status_idx" ON "liabilities"("company_id", "status");
