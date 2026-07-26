-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "account_number" TEXT,
    "bank_name" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'USD',
    "ledger_account_id" TEXT NOT NULL DEFAULT '1100',
    "opening_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "opening_balance_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "account_type" TEXT NOT NULL DEFAULT 'bk_bank',
    "branch" TEXT,
    "swift_code" TEXT,
    "cached_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "cache_valid" BOOLEAN NOT NULL DEFAULT false,
    "cache_last_computed" TIMESTAMPTZ(3),
    "target_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "holder_name" TEXT,
    "last_reconciled_at" TIMESTAMPTZ(3),
    "last_reconciled_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "color" TEXT NOT NULL DEFAULT '#3B82F6',
    "icon" TEXT NOT NULL DEFAULT 'bank',
    "interest_account_type" TEXT NOT NULL DEFAULT 'current',
    "interest_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "interest_calculation_method" TEXT NOT NULL DEFAULT 'simple',
    "interest_credit_frequency" TEXT NOT NULL DEFAULT 'monthly',
    "interest_income_account" TEXT NOT NULL DEFAULT '4300',
    "interest_accrual_account" TEXT NOT NULL DEFAULT '1350',
    "bank_statement_reference" BOOLEAN NOT NULL DEFAULT false,
    "interest_start_date" TIMESTAMPTZ(3),
    "last_interest_posted_date" TIMESTAMPTZ(3),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "bank_account_id" CHAR(24) NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "balance_after" DECIMAL(19,2) NOT NULL,
    "balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "reference" JSONB,
    "reference_type" TEXT,
    "description" TEXT,
    "date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_method" TEXT NOT NULL DEFAULT 'bank_transfer',
    "reference_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "notes" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "journal_entry_id" CHAR(24),
    "journal_entry_line_id" CHAR(24),
    "transaction_type" TEXT NOT NULL DEFAULT 'other',
    "source_document_type" TEXT NOT NULL DEFAULT 'journal_entry',
    "source_document_id" CHAR(24),
    "source_reference" TEXT,
    "reconciliation_status" TEXT NOT NULL DEFAULT 'unreconciled',
    "reconciled_session_id" CHAR(24),
    "is_reversed" BOOLEAN NOT NULL DEFAULT false,
    "reversal_transaction_id" CHAR(24),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "bank_account_id" CHAR(24) NOT NULL,
    "reconciliation_id" CHAR(24),
    "transaction_date" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "debit_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(19,2),
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "is_reconciled" BOOLEAN NOT NULL DEFAULT false,
    "matched_amount" DECIMAL(19,2),
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_reconciliations" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "bank_account_id" CHAR(24) NOT NULL,
    "statement_date_start" TIMESTAMPTZ(3) NOT NULL,
    "statement_date_end" TIMESTAMPTZ(3) NOT NULL,
    "statement_closing_balance" DECIMAL(19,2) NOT NULL,
    "book_closing_balance" DECIMAL(19,2),
    "difference" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "started_by" CHAR(24) NOT NULL,
    "completed_by" CHAR(24),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "report_snapshot" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_reconciliation_sessions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "bank_account_id" CHAR(24) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "opening_book_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "closing_book_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "opening_statement_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "closing_statement_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "completed_at" TIMESTAMPTZ(3),
    "completed_by" CHAR(24),
    "locked_at" TIMESTAMPTZ(3),
    "adjusted_book_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "adjusted_bank_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "is_balanced" BOOLEAN NOT NULL DEFAULT false,
    "outstanding_deposits" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "outstanding_checks" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "unrecorded_bank_items" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_reconciliation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_transactions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "bank_account_id" CHAR(24) NOT NULL,
    "reconciliation_session_id" CHAR(24) NOT NULL,
    "date" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "debit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "match_status" TEXT NOT NULL DEFAULT 'unmatched',
    "matched_book_transaction_id" CHAR(24),
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "import_source" TEXT NOT NULL DEFAULT 'manual',
    "is_adjustment" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_statement_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_reconciliation_matches" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "session_id" CHAR(24),
    "book_transaction_id" CHAR(24),
    "statement_transaction_id" CHAR(24),
    "bank_statement_line_id" CHAR(24),
    "journal_entry_line_id" CHAR(24),
    "journal_entry_id" CHAR(24),
    "bank_account_id" CHAR(24),
    "match_type" TEXT NOT NULL DEFAULT 'manual',
    "amount" DECIMAL(19,2),
    "matched_amount" DECIMAL(19,2),
    "matched_by" CHAR(24),
    "matched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_floats" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "ledger_account_id" TEXT NOT NULL DEFAULT '1050',
    "opening_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "current_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "float_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "imprest_mode" BOOLEAN NOT NULL DEFAULT true,
    "minimum_balance" DECIMAL(19,2) NOT NULL DEFAULT 10000,
    "custodian_id" CHAR(24) NOT NULL,
    "location" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "cached_balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "cache_valid" BOOLEAN NOT NULL DEFAULT false,
    "cache_last_computed" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "petty_cash_floats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_expenses" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "float_id" CHAR(24) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "expense_account_id" TEXT NOT NULL DEFAULT '5100',
    "category" TEXT NOT NULL DEFAULT 'office_stationery',
    "subcategory" TEXT,
    "recipient_type" TEXT,
    "is_taxable" BOOLEAN NOT NULL DEFAULT false,
    "is_staff_advance" BOOLEAN NOT NULL DEFAULT false,
    "staff_advance_status" TEXT,
    "purpose" TEXT,
    "date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receipt_number" TEXT,
    "receipt_image" JSONB,
    "receipt_upload_url" TEXT,
    "receipt_upload_name" TEXT,
    "notes" TEXT,
    "voucher_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "petty_cash_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_replenishments" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "float_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "actual_amount" DECIMAL(19,2),
    "reason" TEXT,
    "receipts" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" CHAR(24) NOT NULL,
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "completed_by" CHAR(24),
    "completed_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "replenishment_number" TEXT,
    "bank_account_id" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "petty_cash_replenishments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_transactions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "float_id" CHAR(24) NOT NULL,
    "reference_no" TEXT,
    "voucher_number" TEXT,
    "type" TEXT NOT NULL,
    "transaction_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "reference_id" CHAR(24),
    "reference_type" TEXT,
    "amount" DECIMAL(19,2) NOT NULL,
    "receipt_ref" TEXT,
    "expense_account_id" TEXT,
    "balance_after" DECIMAL(19,2) NOT NULL,
    "description" TEXT NOT NULL,
    "journal_entry_id" CHAR(24),
    "created_by" CHAR(24) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "petty_cash_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_reconciliations" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "float_id" CHAR(24) NOT NULL,
    "reconciliation_number" TEXT NOT NULL,
    "count_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "system_balance" DECIMAL(19,2) NOT NULL,
    "cash_denominations" JSONB NOT NULL DEFAULT '[]',
    "physical_cash_total" DECIMAL(19,2) NOT NULL,
    "difference" DECIMAL(19,2) NOT NULL,
    "difference_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "counted_by" CHAR(24) NOT NULL,
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "discrepancy_explanation" TEXT,
    "shortage_overage_account_id" TEXT NOT NULL DEFAULT '5900',
    "journal_entry_id" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "petty_cash_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_snapshots" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "report_type" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "period_label" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "period_number" INTEGER NOT NULL,
    "data" JSONB,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "top_products" JSONB NOT NULL DEFAULT '[]',
    "top_customers" JSONB NOT NULL DEFAULT '[]',
    "comparison" JSONB NOT NULL DEFAULT '{}',
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" CHAR(24),
    "calculation_source" TEXT NOT NULL DEFAULT 'snapshot',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error_message" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_accounts_company_id_is_active_idx" ON "bank_accounts"("company_id", "is_active");

-- CreateIndex
CREATE INDEX "bank_accounts_company_id_account_type_idx" ON "bank_accounts"("company_id", "account_type");

-- CreateIndex
CREATE INDEX "bank_accounts_company_id_is_default_idx" ON "bank_accounts"("company_id", "is_default");

-- CreateIndex
CREATE INDEX "bank_transactions_company_id_bank_account_id_date_idx" ON "bank_transactions"("company_id", "bank_account_id", "date" DESC);

-- CreateIndex
CREATE INDEX "bank_transactions_company_id_bank_account_id_reconciliation_idx" ON "bank_transactions"("company_id", "bank_account_id", "reconciliation_status");

-- CreateIndex
CREATE INDEX "bank_transactions_company_id_journal_entry_id_journal_entry_idx" ON "bank_transactions"("company_id", "journal_entry_id", "journal_entry_line_id");

-- CreateIndex
CREATE INDEX "bank_transactions_bank_account_id_date_idx" ON "bank_transactions"("bank_account_id", "date" DESC);

-- CreateIndex
CREATE INDEX "bank_statement_lines_bank_account_id_transaction_date_idx" ON "bank_statement_lines"("bank_account_id", "transaction_date");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bank_account_id_is_reconciled_idx" ON "bank_statement_lines"("bank_account_id", "is_reconciled");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bank_account_id_status_idx" ON "bank_statement_lines"("bank_account_id", "status");

-- CreateIndex
CREATE INDEX "bank_statement_lines_reconciliation_id_status_idx" ON "bank_statement_lines"("reconciliation_id", "status");

-- CreateIndex
CREATE INDEX "bank_statement_lines_company_id_bank_account_id_idx" ON "bank_statement_lines"("company_id", "bank_account_id");

-- CreateIndex
CREATE INDEX "bank_reconciliations_bank_account_id_status_idx" ON "bank_reconciliations"("bank_account_id", "status");

-- CreateIndex
CREATE INDEX "bank_reconciliations_bank_account_id_statement_date_end_idx" ON "bank_reconciliations"("bank_account_id", "statement_date_end" DESC);

-- CreateIndex
CREATE INDEX "bank_reconciliations_company_id_status_idx" ON "bank_reconciliations"("company_id", "status");

-- CreateIndex
CREATE INDEX "bank_reconciliation_sessions_company_id_bank_account_id_per_idx" ON "bank_reconciliation_sessions"("company_id", "bank_account_id", "period_end" DESC);

-- CreateIndex
CREATE INDEX "bank_reconciliation_sessions_company_id_status_idx" ON "bank_reconciliation_sessions"("company_id", "status");

-- CreateIndex
CREATE INDEX "bank_statement_transactions_company_id_reconciliation_sessi_idx" ON "bank_statement_transactions"("company_id", "reconciliation_session_id", "match_status");

-- CreateIndex
CREATE INDEX "bank_statement_transactions_company_id_bank_account_id_date_idx" ON "bank_statement_transactions"("company_id", "bank_account_id", "date");

-- CreateIndex
CREATE INDEX "bank_reconciliation_matches_company_id_session_id_idx" ON "bank_reconciliation_matches"("company_id", "session_id");

-- CreateIndex
CREATE INDEX "bank_reconciliation_matches_company_id_bank_account_id_idx" ON "bank_reconciliation_matches"("company_id", "bank_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_reconciliation_matches_session_id_book_transaction_id__key" ON "bank_reconciliation_matches"("session_id", "book_transaction_id", "statement_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_reconciliation_matches_bank_statement_line_id_journal__key" ON "bank_reconciliation_matches"("bank_statement_line_id", "journal_entry_line_id");

-- CreateIndex
CREATE INDEX "petty_cash_floats_company_id_is_active_idx" ON "petty_cash_floats"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_expenses_voucher_number_key" ON "petty_cash_expenses"("voucher_number");

-- CreateIndex
CREATE INDEX "petty_cash_expenses_company_id_float_id_date_idx" ON "petty_cash_expenses"("company_id", "float_id", "date" DESC);

-- CreateIndex
CREATE INDEX "petty_cash_expenses_company_id_status_idx" ON "petty_cash_expenses"("company_id", "status");

-- CreateIndex
CREATE INDEX "petty_cash_replenishments_company_id_float_id_status_idx" ON "petty_cash_replenishments"("company_id", "float_id", "status");

-- CreateIndex
CREATE INDEX "petty_cash_replenishments_company_id_status_idx" ON "petty_cash_replenishments"("company_id", "status");

-- CreateIndex
CREATE INDEX "petty_cash_replenishments_company_id_created_at_idx" ON "petty_cash_replenishments"("company_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_transactions_reference_no_key" ON "petty_cash_transactions"("reference_no");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_transactions_voucher_number_key" ON "petty_cash_transactions"("voucher_number");

-- CreateIndex
CREATE INDEX "petty_cash_transactions_company_id_float_id_transaction_dat_idx" ON "petty_cash_transactions"("company_id", "float_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "petty_cash_transactions_company_id_reference_no_idx" ON "petty_cash_transactions"("company_id", "reference_no");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_reconciliations_reconciliation_number_key" ON "petty_cash_reconciliations"("reconciliation_number");

-- CreateIndex
CREATE INDEX "petty_cash_reconciliations_company_id_float_id_count_date_idx" ON "petty_cash_reconciliations"("company_id", "float_id", "count_date" DESC);

-- CreateIndex
CREATE INDEX "petty_cash_reconciliations_company_id_status_idx" ON "petty_cash_reconciliations"("company_id", "status");

-- CreateIndex
CREATE INDEX "report_snapshots_company_id_period_type_period_start_idx" ON "report_snapshots"("company_id", "period_type", "period_start" DESC);

-- CreateIndex
CREATE INDEX "report_snapshots_company_id_report_type_year_period_number_idx" ON "report_snapshots"("company_id", "report_type", "year", "period_number");

-- CreateIndex
CREATE INDEX "report_snapshots_generated_at_idx" ON "report_snapshots"("generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_snapshots_company_id_report_type_period_type_year_pe_key" ON "report_snapshots"("company_id", "report_type", "period_type", "year", "period_number");

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reconciled_session_id_fkey" FOREIGN KEY ("reconciled_session_id") REFERENCES "bank_reconciliation_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reversal_transaction_id_fkey" FOREIGN KEY ("reversal_transaction_id") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "bank_reconciliations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_sessions" ADD CONSTRAINT "bank_reconciliation_sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_sessions" ADD CONSTRAINT "bank_reconciliation_sessions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_transactions" ADD CONSTRAINT "bank_statement_transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_transactions" ADD CONSTRAINT "bank_statement_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_transactions" ADD CONSTRAINT "bank_statement_transactions_reconciliation_session_id_fkey" FOREIGN KEY ("reconciliation_session_id") REFERENCES "bank_reconciliation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_transactions" ADD CONSTRAINT "bank_statement_transactions_matched_book_transaction_id_fkey" FOREIGN KEY ("matched_book_transaction_id") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "bank_reconciliation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_book_transaction_id_fkey" FOREIGN KEY ("book_transaction_id") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_statement_transaction_id_fkey" FOREIGN KEY ("statement_transaction_id") REFERENCES "bank_statement_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_bank_statement_line_id_fkey" FOREIGN KEY ("bank_statement_line_id") REFERENCES "bank_statement_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliation_matches" ADD CONSTRAINT "bank_reconciliation_matches_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_float_id_fkey" FOREIGN KEY ("float_id") REFERENCES "petty_cash_floats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_replenishments" ADD CONSTRAINT "petty_cash_replenishments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_replenishments" ADD CONSTRAINT "petty_cash_replenishments_float_id_fkey" FOREIGN KEY ("float_id") REFERENCES "petty_cash_floats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_replenishments" ADD CONSTRAINT "petty_cash_replenishments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_float_id_fkey" FOREIGN KEY ("float_id") REFERENCES "petty_cash_floats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_reconciliations" ADD CONSTRAINT "petty_cash_reconciliations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_reconciliations" ADD CONSTRAINT "petty_cash_reconciliations_float_id_fkey" FOREIGN KEY ("float_id") REFERENCES "petty_cash_floats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

