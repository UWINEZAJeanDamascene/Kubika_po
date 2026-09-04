CREATE TABLE "fixed_deposits" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "bank_account_id" CHAR(24),
  "deposit_reference" TEXT NOT NULL,
  "bank_name" TEXT NOT NULL,
  "principal_amount" DECIMAL(19,4) NOT NULL,
  "interest_rate" DOUBLE PRECISION NOT NULL,
  "start_date" TIMESTAMPTZ(3) NOT NULL,
  "maturity_date" TIMESTAMPTZ(3) NOT NULL,
  "interest_payment_frequency" TEXT NOT NULL DEFAULT 'at_maturity',
  "linked_asset_account" TEXT NOT NULL DEFAULT '1105',
  "linked_income_account" TEXT NOT NULL DEFAULT '4300',
  "linked_accrual_account" TEXT NOT NULL DEFAULT '1350',
  "auto_rollover" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'active',
  "total_interest_accrued" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "total_interest_received" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_by" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fixed_deposits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fixed_deposits_company_status_idx" ON "fixed_deposits"("company_id", "status");
CREATE INDEX "fixed_deposits_company_maturity_date_idx" ON "fixed_deposits"("company_id", "maturity_date");
