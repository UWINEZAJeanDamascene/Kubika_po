ALTER TABLE "stock_movements"
  ADD COLUMN "serial_numbers" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "reversal_of_movement_id" CHAR(24);

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_reversal_of_movement_id_fkey"
  FOREIGN KEY ("reversal_of_movement_id") REFERENCES "stock_movements"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "stock_movements_reversal_of_movement_id_key"
  ON "stock_movements"("reversal_of_movement_id");
