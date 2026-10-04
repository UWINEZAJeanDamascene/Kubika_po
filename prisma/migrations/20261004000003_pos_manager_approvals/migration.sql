CREATE TABLE "pos_manager_approvals" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "cashier_id" CHAR(24) NOT NULL,
  "manager_id" CHAR(24) NOT NULL,
  "till_session_id" CHAR(24),
  "action" VARCHAR(20) NOT NULL,
  "subject_id" CHAR(24),
  "payload_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_manager_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manager_approvals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_manager_approvals_till_session_id_fkey" FOREIGN KEY ("till_session_id") REFERENCES "till_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_manager_approvals_action_check" CHECK ("action" IN ('discount', 'void', 'refund'))
);

CREATE INDEX "pos_manager_approvals_company_cashier_action_exp_idx"
  ON "pos_manager_approvals"("company_id", "cashier_id", "action", "expires_at");
CREATE INDEX "pos_manager_approvals_company_subject_action_idx"
  ON "pos_manager_approvals"("company_id", "subject_id", "action");
