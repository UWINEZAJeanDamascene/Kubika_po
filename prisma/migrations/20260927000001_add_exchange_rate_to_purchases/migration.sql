ALTER TABLE "purchases"
  ADD COLUMN "exchange_rate" DECIMAL(19, 6);

UPDATE "purchases"
SET "exchange_rate" = 1
WHERE UPPER("currency") IN ('RWF', 'FRW');
