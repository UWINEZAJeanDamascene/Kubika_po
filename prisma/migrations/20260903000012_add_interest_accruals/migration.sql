CREATE TABLE "interest_accruals" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "bank_account_id" CHAR(24),
  "fixed_deposit_id" CHAR(24),
  "period_month" INTEGER NOT NULL,
  "period_year" INTEGER NOT NULL,
  "principal" DECIMAL(19,4) NOT NULL,
  "rate" DOUBLE PRECISION NOT NULL,
  "days_in_period" INTEGER NOT NULL DEFAULT 0,
  "calculated_interest" DECIMAL(19,4) NOT NULL,
  "method" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "accrual_journal_entry_id" CHAR(24),
  "receipt_journal_entry_id" CHAR(24),
  "journal_entry_id" CHAR(24),
  "source" TEXT NOT NULL DEFAULT 'auto',
  "source_tag" TEXT NOT NULL DEFAULT 'interest_income_auto',
  "confirmed_at" TIMESTAMPTZ(3),
  "confirmed_by" CHAR(24),
  "notes" TEXT,
  "withholding_tax" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "gross_interest" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "created_by" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interest_accruals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interest_accruals_company_bank_period_key" ON "interest_accruals"("company_id", "bank_account_id", "period_month", "period_year");
CREATE UNIQUE INDEX "interest_accruals_company_deposit_period_key" ON "interest_accruals"("company_id", "fixed_deposit_id", "period_month", "period_year");
CREATE INDEX "interest_accruals_company_status_idx" ON "interest_accruals"("company_id", "status");
