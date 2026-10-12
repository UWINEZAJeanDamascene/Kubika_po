CREATE TABLE "pos_stored_value_accounts" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "client_id" CHAR(24),
  "kind" VARCHAR(20) NOT NULL,
  "code_hash" VARCHAR(64),
  "code_suffix" VARCHAR(8),
  "currency_code" VARCHAR(3) NOT NULL DEFAULT 'RWF',
  "balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "expires_at" TIMESTAMPTZ(3),
  "created_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_stored_value_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_stored_value_accounts_kind_check" CHECK ("kind" IN ('gift_card','store_credit','loyalty')),
  CONSTRAINT "pos_stored_value_accounts_balance_check" CHECK ("balance" >= 0),
  CONSTRAINT "pos_stored_value_accounts_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX "pos_stored_value_accounts_company_code_hash_key"
  ON "pos_stored_value_accounts"("company_id", "code_hash");
CREATE UNIQUE INDEX "pos_stored_value_accounts_company_client_kind_currency_key"
  ON "pos_stored_value_accounts"("company_id", "client_id", "kind", "currency_code");
CREATE INDEX "pos_stored_value_accounts_company_kind_active_idx"
  ON "pos_stored_value_accounts"("company_id", "kind", "is_active");
CREATE INDEX "pos_stored_value_accounts_company_client_kind_idx"
  ON "pos_stored_value_accounts"("company_id", "client_id", "kind");
ALTER TABLE "pos_stored_value_accounts"
  ADD CONSTRAINT "pos_stored_value_accounts_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "pos_stored_value_ledger" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "account_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24),
  "kind" VARCHAR(20) NOT NULL,
  "entry_type" VARCHAR(20) NOT NULL,
  "amount" DECIMAL(19,2) NOT NULL,
  "balance_after" DECIMAL(19,2) NOT NULL,
  "reference" VARCHAR(120),
  "notes" TEXT,
  "created_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_stored_value_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_stored_value_ledger_kind_check" CHECK ("kind" IN ('gift_card','store_credit','loyalty')),
  CONSTRAINT "pos_stored_value_ledger_entry_type_check" CHECK ("entry_type" IN ('issue','redeem','earn','refund','adjust')),
  CONSTRAINT "pos_stored_value_ledger_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "pos_stored_value_ledger_balance_check" CHECK ("balance_after" >= 0)
);
CREATE INDEX "pos_stored_value_ledger_company_account_created_idx"
  ON "pos_stored_value_ledger"("company_id", "account_id", "created_at" DESC);
CREATE INDEX "pos_stored_value_ledger_company_invoice_idx"
  ON "pos_stored_value_ledger"("company_id", "invoice_id");
ALTER TABLE "pos_stored_value_ledger"
  ADD CONSTRAINT "pos_stored_value_ledger_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_stored_value_ledger_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "pos_stored_value_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
