ALTER TABLE "sales_order_lines"
  ADD COLUMN "qty_shipped" DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE "delivery_note_lines"
  ADD COLUMN "sales_order_line_id" CHAR(24);

CREATE INDEX "delivery_note_lines_sales_order_line_id_idx"
  ON "delivery_note_lines"("sales_order_line_id");
