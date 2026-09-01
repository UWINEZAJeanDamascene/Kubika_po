-- CreateTable
CREATE TABLE "ar_transaction_ledger" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "invoice_id" CHAR(24),
    "receipt_id" CHAR(24),
    "transaction_type" TEXT NOT NULL,
    "transaction_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_no" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "direction" TEXT NOT NULL,
    "invoice_balance_after" DECIMAL(19,4),
    "client_balance_after" DECIMAL(19,4),
    "source_type" TEXT NOT NULL,
    "source_id" CHAR(24) NOT NULL,
    "source_reference" TEXT,
    "journal_entry_id" CHAR(24),
    "metadata" JSONB,
    "reconciliation_status" TEXT NOT NULL DEFAULT 'pending',
    "discrepancy_details" JSONB,
    "created_by" CHAR(24),
    "reversed_from" CHAR(24),
    "reversed_by" CHAR(24),
    "fiscal_year" INTEGER,
    "accounting_period" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ar_transaction_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_transaction_ledger" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "transaction_type" TEXT NOT NULL,
    "transaction_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_no" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "direction" TEXT NOT NULL,
    "supplier_balance_after" DECIMAL(19,4),
    "grn_balance_after" DECIMAL(19,4),
    "grn_id" CHAR(24),
    "payment_id" CHAR(24),
    "source_type" TEXT NOT NULL,
    "source_id" CHAR(24) NOT NULL,
    "source_reference" TEXT,
    "created_by" CHAR(24),
    "reconciliation_status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(3),
    "discrepancy_details" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ap_transaction_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_transaction_date_idx" ON "ar_transaction_ledger"("company_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_client_id_transaction_date_idx" ON "ar_transaction_ledger"("company_id", "client_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_invoice_id_transaction_dat_idx" ON "ar_transaction_ledger"("company_id", "invoice_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_transaction_type_idx" ON "ar_transaction_ledger"("company_id", "transaction_type");

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_reconciliation_status_idx" ON "ar_transaction_ledger"("company_id", "reconciliation_status");

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_fiscal_year_accounting_per_idx" ON "ar_transaction_ledger"("company_id", "fiscal_year", "accounting_period");

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_company_id_source_type_source_id_idx" ON "ar_transaction_ledger"("company_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_reversed_from_idx" ON "ar_transaction_ledger"("reversed_from");

-- CreateIndex
CREATE INDEX "ar_transaction_ledger_reversed_by_idx" ON "ar_transaction_ledger"("reversed_by");

-- CreateIndex
CREATE INDEX "ap_transaction_ledger_company_id_supplier_id_transaction_da_idx" ON "ap_transaction_ledger"("company_id", "supplier_id", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "ap_transaction_ledger_company_id_transaction_type_transacti_idx" ON "ap_transaction_ledger"("company_id", "transaction_type", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "ap_transaction_ledger_company_id_reconciliation_status_tran_idx" ON "ap_transaction_ledger"("company_id", "reconciliation_status", "transaction_date" DESC);

-- CreateIndex
CREATE INDEX "ap_transaction_ledger_company_id_source_type_source_id_idx" ON "ap_transaction_ledger"("company_id", "source_type", "source_id");

-- AddForeignKey
ALTER TABLE "ar_transaction_ledger" ADD CONSTRAINT "ar_transaction_ledger_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_transaction_ledger" ADD CONSTRAINT "ar_transaction_ledger_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_transaction_ledger" ADD CONSTRAINT "ap_transaction_ledger_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_transaction_ledger" ADD CONSTRAINT "ap_transaction_ledger_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
