-- CreateTable
CREATE TABLE "loans" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "loan_number" TEXT,
    "lender_name" TEXT,
    "lender_contact" TEXT,
    "name" TEXT NOT NULL,
    "loan_type" TEXT NOT NULL,
    "type" TEXT,
    "purpose" TEXT,
    "original_amount" DECIMAL(19,2) NOT NULL,
    "outstanding_balance" DECIMAL(19,2) NOT NULL,
    "amount_paid" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "interest_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "interest_method" TEXT NOT NULL DEFAULT 'simple',
    "duration_months" INTEGER,
    "liability_account_id" TEXT NOT NULL,
    "interest_expense_account_id" TEXT,
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "payments" JSONB NOT NULL DEFAULT '[]',
    "transactions" JSONB NOT NULL DEFAULT '[]',
    "payment_terms" TEXT NOT NULL DEFAULT 'monthly',
    "monthly_payment" DECIMAL(19,2),
    "collateral" TEXT,
    "notes" TEXT,
    "is_secured" BOOLEAN NOT NULL DEFAULT false,
    "security_description" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'bank_loan',
    "related_party_id" CHAR(24),
    "related_party_name" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "has_covenants" BOOLEAN NOT NULL DEFAULT false,
    "covenant_details" TEXT,
    "covenant_breach" BOOLEAN NOT NULL DEFAULT false,
    "covenant_breach_date" TIMESTAMPTZ(3),
    "ifrs9_classification" TEXT NOT NULL DEFAULT 'amortized_cost',
    "impairment_stage" TEXT NOT NULL DEFAULT 'stage_1',
    "ecl_provision" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "probability_of_default" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "loss_given_default" DECIMAL(19,4) NOT NULL DEFAULT 45,
    "exposure_at_default" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "effective_interest_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "significant_increase_in_credit_risk" BOOLEAN NOT NULL DEFAULT false,
    "credit_risk_assessed_at" TIMESTAMPTZ(3),
    "days_past_due" INTEGER NOT NULL DEFAULT 0,
    "forbearance_status" TEXT NOT NULL DEFAULT 'none',
    "default_date" TIMESTAMPTZ(3),
    "write_off_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "write_off_date" TIMESTAMPTZ(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loans_company_id_loan_number_key" ON "loans"("company_id", "loan_number");

-- CreateIndex
CREATE INDEX "loans_company_id_status_idx" ON "loans"("company_id", "status");

-- CreateIndex
CREATE INDEX "loans_company_id_start_date_idx" ON "loans"("company_id", "start_date" DESC);

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
