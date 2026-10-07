ALTER TABLE "purchase_returns"
  ADD COLUMN "supplier_credit_note_no" TEXT,
  ADD COLUMN "confirmed_by" CHAR(24),
  ADD COLUMN "confirmed_at" TIMESTAMPTZ(3),
  ADD COLUMN "refund_bank_transaction_id" CHAR(24),
  ADD COLUMN "bank_refund_reference" TEXT,
  ADD COLUMN "refunded_at" TIMESTAMPTZ(3);

ALTER TABLE "grn_lines"
  ADD COLUMN "landed_unit_cost" DECIMAL(19, 6);
