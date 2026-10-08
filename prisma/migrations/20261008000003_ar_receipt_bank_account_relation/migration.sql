ALTER TABLE "ar_receipts"
  ADD CONSTRAINT "ar_receipts_bank_account_id_fkey"
  FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ar_receipts_bank_account_id_idx"
  ON "ar_receipts"("bank_account_id");
