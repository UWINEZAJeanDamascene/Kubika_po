CREATE TABLE "pos_offline_snapshots" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "user_id" CHAR(24) NOT NULL,
  "device_id" VARCHAR(160) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "warehouse_id" CHAR(24) NOT NULL,
  "till_session_id" CHAR(24) NOT NULL,
  "snapshot_data" JSONB NOT NULL,
  "queue_limit" DECIMAL(19,2) NOT NULL,
  "used_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "issued_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_offline_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_offline_snapshots_binding_idx"
  ON "pos_offline_snapshots" ("company_id", "user_id", "device_id", "register_id", "expires_at");

CREATE TABLE "pos_offline_sales" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "snapshot_id" CHAR(24) NOT NULL,
  "offline_sale_id" VARCHAR(100) NOT NULL,
  "request_key" VARCHAR(100) NOT NULL,
  "cashier_id" CHAR(24) NOT NULL,
  "device_id" VARCHAR(160) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "warehouse_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "total" DECIMAL(19,2) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "reported_sale_at" TIMESTAMPTZ(3) NOT NULL,
  "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_offline_sales_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_offline_sales_company_offline_sale_key" UNIQUE ("company_id", "offline_sale_id"),
  CONSTRAINT "pos_offline_sales_company_request_key" UNIQUE ("company_id", "request_key")
);
CREATE INDEX "pos_offline_sales_company_snapshot_synced_idx"
  ON "pos_offline_sales" ("company_id", "snapshot_id", "synced_at");
CREATE INDEX "pos_offline_sales_company_register_synced_idx"
  ON "pos_offline_sales" ("company_id", "register_id", "synced_at");

CREATE TABLE "pos_offline_conflicts" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "offline_sale_id" VARCHAR(100) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "product_id" CHAR(24) NOT NULL,
  "warehouse_id" CHAR(24) NOT NULL,
  "conflict_type" VARCHAR(24) NOT NULL,
  "details" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'open',
  "escalation_at" TIMESTAMPTZ(3) NOT NULL,
  "resolved_at" TIMESTAMPTZ(3),
  "resolved_by_id" CHAR(24),
  "resolution" VARCHAR(40),
  "resolution_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_offline_conflicts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_offline_conflicts_company_status_escalation_idx"
  ON "pos_offline_conflicts" ("company_id", "status", "escalation_at");
CREATE INDEX "pos_offline_conflicts_company_invoice_idx"
  ON "pos_offline_conflicts" ("company_id", "invoice_id");
