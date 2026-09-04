CREATE TABLE "subscriptions" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "client_id" CHAR(24) NOT NULL,
  "recurring_invoice_id" CHAR(24),
  "plan_name" TEXT,
  "amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'FRW',
  "billing_cycle" TEXT NOT NULL,
  "interval" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'active',
  "start_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "end_date" TIMESTAMPTZ(3),
  "next_billing_date" TIMESTAMPTZ(3),
  "created_by" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscriptions_company_id_idx" ON "subscriptions"("company_id");
CREATE INDEX "subscriptions_company_status_idx" ON "subscriptions"("company_id", "status");
