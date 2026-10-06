ALTER TABLE "invoice_lines"
  ADD COLUMN IF NOT EXISTS "qty_delivered" DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE "stock_serial_numbers"
  ADD COLUMN IF NOT EXISTS "dispatched_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "returned_at" TIMESTAMPTZ(3);

ALTER TABLE "credit_note_lines"
  ADD COLUMN IF NOT EXISTS "discount_pct" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "line_subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "line_tax" DECIMAL(19,2) NOT NULL DEFAULT 0;

UPDATE "credit_note_lines"
SET "line_subtotal" = CASE
      WHEN "tax_rate" > 0 THEN ROUND("line_total" / (1 + "tax_rate" / 100), 2)
      ELSE "line_total"
    END,
    "line_tax" = CASE
      WHEN "tax_rate" > 0 THEN "line_total" - ROUND("line_total" / (1 + "tax_rate" / 100), 2)
      ELSE 0
    END
WHERE "line_subtotal" = 0 AND "line_total" <> 0;

ALTER TABLE "credit_notes"
  ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "amount_refunded" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "amount_applied_to_ar" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "amount_available_as_credit" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "amount_refunded_from_ar" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "amount_refunded_from_credit" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "amount_applied_to_other_invoices" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "applications" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "applied_to_invoice_id" CHAR(24),
  ADD COLUMN IF NOT EXISTS "applied_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

UPDATE "credit_notes" AS cn
SET "amount_refunded" = COALESCE((
  SELECT SUM(
    CASE
      WHEN (payment->>'amount') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (payment->>'amount')::DECIMAL(19,2)
      ELSE 0
    END
  )
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(cn."payments") = 'array' THEN cn."payments" ELSE '[]'::jsonb END
  ) AS payment
), 0)
WHERE cn."amount_refunded" = 0;

UPDATE "credit_notes"
SET "amount_applied_to_ar" = "total_amount",
    "amount_refunded_from_ar" = "amount_refunded"
WHERE "status" <> 'draft'
  AND "amount_applied_to_ar" = 0
  AND "amount_available_as_credit" = 0;

ALTER TABLE "delivery_notes"
  ADD COLUMN IF NOT EXISTS "confirmed_by" CHAR(24),
  ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "dispatched_by" CHAR(24),
  ADD COLUMN IF NOT EXISTS "dispatched_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "delivered_by" TEXT,
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "received_by" TEXT,
  ADD COLUMN IF NOT EXISTS "actual_delivery_date" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "carrier" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicle" TEXT,
  ADD COLUMN IF NOT EXISTS "tracking_number" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_address" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelled_by" CHAR(24),
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "cancellation_reason" TEXT;

CREATE INDEX IF NOT EXISTS "credit_notes_company_status_refund_idx"
  ON "credit_notes" ("company_id", "status", "amount_refunded");
