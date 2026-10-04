CREATE TABLE "pos_sale_requests" (
  "company_id" CHAR(24) NOT NULL,
  "request_key" VARCHAR(100) NOT NULL,
  "created_by_id" CHAR(24) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "invoice_id" CHAR(24),
  "status" TEXT NOT NULL DEFAULT 'processing',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_sale_requests_pkey" PRIMARY KEY ("company_id", "request_key"),
  CONSTRAINT "pos_sale_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_sale_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_sale_requests_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_sale_requests_status_check" CHECK ("status" IN ('processing', 'completed'))
);

CREATE INDEX "pos_sale_requests_created_at_idx" ON "pos_sale_requests"("created_at");
