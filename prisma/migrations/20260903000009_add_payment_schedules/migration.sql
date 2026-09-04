CREATE TABLE "payment_schedules" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "purchase_id" CHAR(24) NOT NULL,
  "supplier_id" CHAR(24) NOT NULL,
  "installment_number" INTEGER NOT NULL,
  "scheduled_amount" DECIMAL(19,4) NOT NULL,
  "scheduled_date" TIMESTAMPTZ(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "paid_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "paid_date" TIMESTAMPTZ(3),
  "payment_method" TEXT,
  "payment_reference" TEXT,
  "payment_notes" TEXT,
  "early_payment_discount" JSONB NOT NULL DEFAULT '{}',
  "notes" TEXT,
  "created_by" CHAR(24),
  "updated_by" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_schedules_company_purchase_idx" ON "payment_schedules"("company_id", "purchase_id");
CREATE INDEX "payment_schedules_company_supplier_idx" ON "payment_schedules"("company_id", "supplier_id");
CREATE INDEX "payment_schedules_company_scheduled_date_idx" ON "payment_schedules"("company_id", "scheduled_date");
CREATE INDEX "payment_schedules_company_status_idx" ON "payment_schedules"("company_id", "status");
