ALTER TABLE "purchase_returns"
  ALTER COLUMN "grn_id" DROP NOT NULL,
  ADD COLUMN "purchase_id" CHAR(24);

ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_purchase_id_fkey"
  FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "purchase_returns_purchase_id_idx"
  ON "purchase_returns"("purchase_id");

ALTER TABLE "purchase_return_lines"
  ADD COLUMN "purchase_line_id" CHAR(24);
