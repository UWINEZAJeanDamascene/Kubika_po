ALTER TABLE "till_sessions"
  ADD COLUMN "register_id" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "register_name" TEXT NOT NULL DEFAULT 'Register',
  ADD COLUMN "expected_cash" DECIMAL(19,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cash_variance" DECIMAL(19,2),
  ADD COLUMN "cash_activity" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "handover_from_id" CHAR(24),
  ADD COLUMN "handover_to_id" CHAR(24),
  ADD COLUMN "close_notes" TEXT;

UPDATE "till_sessions"
SET "register_id" = 'legacy-' || "opened_by" || '-' || "id",
    "expected_cash" = "opening_float";

CREATE INDEX "till_sessions_company_register_status_idx"
  ON "till_sessions"("company_id", "register_id", "status");

CREATE UNIQUE INDEX "till_sessions_one_open_register_idx"
  ON "till_sessions"("company_id", "register_id")
  WHERE "status" = 'open';
