CREATE TABLE "cash_drawers" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "drawer_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'closed',
  "opened_by" CHAR(24),
  "opened_at" TIMESTAMPTZ(3),
  "closed_by" CHAR(24),
  "closed_at" TIMESTAMPTZ(3),
  "opening_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "closing_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "transactions" JSONB NOT NULL DEFAULT '[]',
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_drawers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cash_drawers_company_drawer_id_key" ON "cash_drawers"("company_id", "drawer_id");
CREATE INDEX "cash_drawers_company_status_idx" ON "cash_drawers"("company_id", "status");
