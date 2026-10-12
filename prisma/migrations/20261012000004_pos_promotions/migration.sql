ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "pos_promotion" JSONB;

CREATE TABLE "pos_promotions" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "discount_type" VARCHAR(16) NOT NULL,
  "value" DECIMAL(19,4) NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_by_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_promotions_discount_type_check" CHECK ("discount_type" IN ('percent', 'fixed')),
  CONSTRAINT "pos_promotions_value_check" CHECK ("value" > 0),
  CONSTRAINT "pos_promotions_validity_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "pos_promotions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_promotions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_promotions_company_id_code_key" ON "pos_promotions"("company_id", "code");
CREATE INDEX "pos_promotions_company_id_is_active_starts_at_ends_at_idx"
  ON "pos_promotions"("company_id", "is_active", "starts_at", "ends_at");
