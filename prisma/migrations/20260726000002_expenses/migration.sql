-- CreateTable
CREATE TABLE "expenses" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT,
    "expense_number" TEXT,
    "expense_date" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "expense_account_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "amount_in_rwf" DECIMAL(19,2),
    "tax_amount_in_rwf" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount_in_rwf" DECIMAL(19,2),
    "tax_account_id" CHAR(24),
    "payment_method" TEXT NOT NULL,
    "bank_account_id" CHAR(24),
    "petty_cash_fund_id" CHAR(24),
    "rra_tax_category" TEXT NOT NULL DEFAULT 'vat_standard',
    "rra_tax_transaction_id" CHAR(24),
    "is_vat_recoverable" BOOLEAN NOT NULL DEFAULT true,
    "withholding_tax" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "withholding_tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "withholding_tax_in_rwf" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "department_id" CHAR(24),
    "department_allocations" JSONB NOT NULL DEFAULT '[]',
    "budget_id" CHAR(24),
    "budget_line_id" CHAR(24),
    "encumbrance_id" CHAR(24),
    "supplier_id" CHAR(24),
    "receipt_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by" CHAR(24),
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "journal_entry_id" CHAR(24),
    "reversal_journal_entry_id" CHAR(24),
    "posted_by" CHAR(24) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'other_expense',
    "category" TEXT,
    "period" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paid_date" TIMESTAMPTZ(3),
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurring_frequency" TEXT NOT NULL DEFAULT 'monthly',
    "created_by" CHAR(24),
    "notes" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expenses_company_id_reference_no_key" ON "expenses"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "expenses_company_id_expense_date_idx" ON "expenses"("company_id", "expense_date" DESC);

-- CreateIndex
CREATE INDEX "expenses_company_id_status_idx" ON "expenses"("company_id", "status");

-- CreateIndex
CREATE INDEX "expenses_company_id_type_idx" ON "expenses"("company_id", "type");

-- CreateIndex
CREATE INDEX "expenses_company_id_payment_method_idx" ON "expenses"("company_id", "payment_method");

-- CreateIndex
CREATE INDEX "expenses_company_id_expense_account_id_idx" ON "expenses"("company_id", "expense_account_id");

-- CreateIndex
CREATE INDEX "expenses_company_id_department_id_idx" ON "expenses"("company_id", "department_id");

-- CreateIndex
CREATE INDEX "expenses_company_id_period_idx" ON "expenses"("company_id", "period");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
