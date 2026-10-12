CREATE TABLE "pos_sale_request_recoveries" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "original_request_key" VARCHAR(100) NOT NULL,
    "replacement_request_key" VARCHAR(100) NOT NULL,
    "pending_payload_hash" CHAR(64) NOT NULL,
    "original_payload_hash" CHAR(64) NOT NULL,
    "original_invoice_id" CHAR(24) NOT NULL,
    "initiated_by_id" CHAR(24) NOT NULL,
    "approved_by_id" CHAR(24) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pos_sale_request_recoveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pos_sale_request_recoveries_distinct_users_check" CHECK ("initiated_by_id" <> "approved_by_id")
);

CREATE UNIQUE INDEX "pos_sale_request_recoveries_company_replacement_key"
  ON "pos_sale_request_recoveries"("company_id", "replacement_request_key");

CREATE INDEX "pos_sale_request_recoveries_company_original_created_idx"
  ON "pos_sale_request_recoveries"("company_id", "original_request_key", "created_at");

UPDATE "roles"
SET "permissions" = COALESCE("permissions", '[]'::jsonb) ||
  '[{"resource":"tills","actions":["read","open","close"]}]'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "name" = 'manager' AND "is_system_role" = TRUE;
