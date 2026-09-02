ALTER TABLE "invoices"
  ADD COLUMN "bad_debt_written_off" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "written_off_at" TIMESTAMPTZ(3),
  ADD COLUMN "written_off_by" CHAR(24),
  ADD COLUMN "bad_debt_reason" TEXT;

CREATE INDEX "invoices_company_bad_debt_idx"
  ON "invoices"("company_id", "bad_debt_written_off");

CREATE TABLE "ar_bad_debt_writeoffs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "reference_no" TEXT NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "client_id" CHAR(24) NOT NULL,
  "writeoff_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amount" DECIMAL(19,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "notes" TEXT,
  "journal_entry_id" CHAR(24),
  "posted_by" CHAR(24),
  "status" TEXT NOT NULL DEFAULT 'draft',
  "reversed_at" TIMESTAMPTZ(3),
  "reversed_by" CHAR(24),
  "reversal_reason" TEXT,
  "reverse_journal_entry_id" CHAR(24),
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ar_bad_debt_writeoffs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ar_bad_debt_writeoffs_company_reference_key"
  ON "ar_bad_debt_writeoffs"("company_id", "reference_no");
CREATE INDEX "ar_bad_debt_writeoffs_company_status_idx"
  ON "ar_bad_debt_writeoffs"("company_id", "status");
CREATE INDEX "ar_bad_debt_writeoffs_company_invoice_idx"
  ON "ar_bad_debt_writeoffs"("company_id", "invoice_id");
CREATE INDEX "ar_bad_debt_writeoffs_company_client_idx"
  ON "ar_bad_debt_writeoffs"("company_id", "client_id");
CREATE INDEX "ar_bad_debt_writeoffs_company_date_idx"
  ON "ar_bad_debt_writeoffs"("company_id", "writeoff_date" DESC);

ALTER TABLE "ar_bad_debt_writeoffs"
  ADD CONSTRAINT "ar_bad_debt_writeoffs_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ar_bad_debt_writeoffs_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ar_bad_debt_writeoffs_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
