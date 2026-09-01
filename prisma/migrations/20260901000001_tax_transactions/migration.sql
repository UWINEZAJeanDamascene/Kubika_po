-- Tax transaction ledger (migrated from MongoDB taxtransactions collection).

CREATE TABLE "tax_transactions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "tax_type" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "net_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "gross_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source_type" TEXT NOT NULL,
    "source_id" CHAR(24),
    "source_reference" TEXT,
    "journal_entry_id" CHAR(24),
    "journal_entry_number" TEXT,
    "account_code" TEXT NOT NULL,
    "tax_rate_id" CHAR(24),
    "tax_code" TEXT,
    "period_month" INTEGER,
    "period_year" INTEGER,
    "date" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "reversal_of_id" CHAR(24),
    "created_by" CHAR(24),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_transactions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_journal_entry_id_fkey"
    FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_tax_rate_id_fkey"
    FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_reversal_of_id_fkey"
    FOREIGN KEY ("reversal_of_id") REFERENCES "tax_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tax_transactions_company_id_date_idx"
    ON "tax_transactions"("company_id", "date" DESC);

CREATE INDEX "tax_transactions_company_id_tax_type_date_idx"
    ON "tax_transactions"("company_id", "tax_type", "date" DESC);

CREATE INDEX "tax_transactions_company_id_direction_date_idx"
    ON "tax_transactions"("company_id", "direction", "date" DESC);

CREATE INDEX "tax_transactions_company_id_source_type_date_idx"
    ON "tax_transactions"("company_id", "source_type", "date" DESC);

CREATE INDEX "tax_transactions_company_id_status_date_idx"
    ON "tax_transactions"("company_id", "status", "date" DESC);

CREATE INDEX "tax_transactions_company_id_period_year_period_month_idx"
    ON "tax_transactions"("company_id", "period_year", "period_month");

CREATE INDEX "tax_transactions_company_id_tax_type_direction_status_date_idx"
    ON "tax_transactions"("company_id", "tax_type", "direction", "status", "date" DESC);

CREATE INDEX "tax_transactions_journal_entry_id_idx"
    ON "tax_transactions"("journal_entry_id");

CREATE INDEX "tax_transactions_company_id_journal_entry_id_idx"
    ON "tax_transactions"("company_id", "journal_entry_id");
