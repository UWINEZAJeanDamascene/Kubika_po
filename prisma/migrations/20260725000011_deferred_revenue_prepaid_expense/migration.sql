-- CreateTable
CREATE TABLE "deferred_revenues" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "customer" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "total_amount" DECIMAL(19,2) NOT NULL,
    "revenue_account_code" TEXT NOT NULL,
    "payment_method" TEXT NOT NULL DEFAULT 'cash',
    "bank_account_id" CHAR(24),
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "status" TEXT NOT NULL DEFAULT 'active',
    "remaining_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_recognized" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "recognitions" JSONB NOT NULL DEFAULT '[]',
    "journal_entry_id" CHAR(24),
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deferred_revenues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prepaid_expenses" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "total_amount" DECIMAL(19,2) NOT NULL,
    "expense_account_code" TEXT NOT NULL,
    "payment_method" TEXT NOT NULL DEFAULT 'cash',
    "bank_account_id" CHAR(24),
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "status" TEXT NOT NULL DEFAULT 'active',
    "remaining_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amortized" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "amortizations" JSONB NOT NULL DEFAULT '[]',
    "journal_entry_id" CHAR(24),
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prepaid_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deferred_revenues_company_id_reference_no_key" ON "deferred_revenues"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "deferred_revenues_company_id_status_idx" ON "deferred_revenues"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prepaid_expenses_company_id_reference_no_key" ON "prepaid_expenses"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "prepaid_expenses_company_id_status_idx" ON "prepaid_expenses"("company_id", "status");

-- AddForeignKey
ALTER TABLE "deferred_revenues" ADD CONSTRAINT "deferred_revenues_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepaid_expenses" ADD CONSTRAINT "prepaid_expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
