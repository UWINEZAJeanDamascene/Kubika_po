ALTER TABLE "purchase_return_lines"
  ADD COLUMN "serial_numbers" JSONB NOT NULL DEFAULT '[]';
