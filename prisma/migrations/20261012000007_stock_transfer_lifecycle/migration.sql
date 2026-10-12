ALTER TYPE "StockSerialStatus" ADD VALUE IF NOT EXISTS 'in_transit';

ALTER TABLE "stock_transfers"
  ADD COLUMN "discrepancy_by" CHAR(24),
  ADD COLUMN "discrepancy_at" TIMESTAMPTZ(3),
  ADD COLUMN "cancelled_by" CHAR(24),
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(3),
  ADD COLUMN "in_transit_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN "expected_arrival_at" TIMESTAMPTZ(3);

ALTER TABLE "stock_transfer_lines"
  ADD COLUMN "qty_received" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN "in_transit_qty" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN "in_transit_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN "inventory_identity" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "received_identity" JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE "stock_transfer_lines" AS line
   SET "in_transit_qty" = line."qty",
       "in_transit_value" = ROUND(line."qty" * COALESCE(line."unit_cost", 0), 2)
  FROM "stock_transfers" AS transfer
 WHERE transfer."id" = line."transfer_id"
   AND transfer."status" = 'in_transit'
   AND line."in_transit_qty" = 0;

UPDATE "stock_transfers" AS transfer
   SET "in_transit_value" = totals.total_value
  FROM (
    SELECT "transfer_id", SUM("in_transit_value") AS total_value
      FROM "stock_transfer_lines"
     GROUP BY "transfer_id"
  ) AS totals
 WHERE transfer."id" = totals."transfer_id"
   AND transfer."status" = 'in_transit';

CREATE TABLE "stock_transfer_discrepancies" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "transfer_id" CHAR(24) NOT NULL,
  "transfer_line_id" CHAR(24) NOT NULL,
  "expected_qty" DECIMAL(19,4) NOT NULL,
  "received_qty" DECIMAL(19,4) NOT NULL,
  "variance_qty" DECIMAL(19,4) NOT NULL,
  "notes" TEXT,
  "recorded_by" CHAR(24) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_transfer_discrepancies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_transfer_discrepancies_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_discrepancies_transfer_line_id_fkey"
    FOREIGN KEY ("transfer_line_id") REFERENCES "stock_transfer_lines"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_discrepancies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "stock_transfer_discrepancies_company_id_transfer_id_idx"
  ON "stock_transfer_discrepancies"("company_id", "transfer_id");
