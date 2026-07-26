-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('individual', 'company');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('cash', 'credit_7', 'credit_15', 'credit_30', 'credit_45', 'credit_60');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense', 'cogs');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "TaxRateType" AS ENUM ('vat', 'sales_tax', 'withholding', 'exempt', 'zero_rated');

-- CreateEnum
CREATE TYPE "TaxRecordType" AS ENUM ('vat', 'corporate_income', 'paye', 'withholding', 'trading_license');

-- CreateEnum
CREATE TYPE "TaxRecordStatus" AS ENUM ('active', 'inactive', 'pending');

-- CreateEnum
CREATE TYPE "TradingLicenseStatus" AS ENUM ('active', 'expired', 'pending', 'not_applicable');

-- CreateEnum
CREATE TYPE "BarcodeType" AS ENUM ('CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39', 'ITF14', 'QR', 'NONE');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('fifo', 'weighted', 'wac', 'avg');

-- CreateEnum
CREATE TYPE "TrackingType" AS ENUM ('none', 'batch', 'serial');

-- CreateEnum
CREATE TYPE "EbmRegistrationStatus" AS ENUM ('not_registered', 'registered', 'failed');

-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('manual', 'api', 'import');

-- CreateTable
CREATE TABLE "categories" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parent_id" CHAR(24),
    "default_inventory_account" TEXT,
    "default_cogs_account" TEXT,
    "default_revenue_account" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "location" JSONB NOT NULL DEFAULT '{}',
    "inventory_account" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "total_products" INTEGER NOT NULL DEFAULT 0,
    "total_value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_by" CHAR(24),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "rra_branch_id" VARCHAR(2),
    "ebm_registration_status" "EbmRegistrationStatus" NOT NULL DEFAULT 'not_registered',
    "ebm_registered_at" TIMESTAMPTZ(3),
    "ebm_last_attempt_at" TIMESTAMPTZ(3),
    "ebm_registration_error" TEXT,
    "ebm_users_submitted" BOOLEAN NOT NULL DEFAULT false,
    "ebm_insurances" JSONB NOT NULL DEFAULT '[]',
    "ebm_insurance_submitted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ClientType" NOT NULL DEFAULT 'individual',
    "contact" JSONB NOT NULL DEFAULT '{}',
    "sales_area" TEXT,
    "sales_rep_id" TEXT,
    "region" TEXT,
    "industry" TEXT,
    "registration_date" TIMESTAMPTZ(3),
    "tax_id" TEXT,
    "ebm_tin_verification" JSONB,
    "payment_terms" "PaymentTerms" NOT NULL DEFAULT 'cash',
    "credit_limit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "outstanding_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total_purchases" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "last_purchase_date" TIMESTAMPTZ(3),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "ebm_branch_customers" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contact" JSONB NOT NULL DEFAULT '{}',
    "region" TEXT,
    "currency" TEXT,
    "lead_time" INTEGER,
    "minimum_order" DECIMAL(19,4),
    "bank_name" TEXT,
    "bank_account" TEXT,
    "products_supplied" CHAR(24)[] DEFAULT ARRAY[]::CHAR(24)[],
    "payment_terms" "PaymentTerms" NOT NULL DEFAULT 'cash',
    "tax_id" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "total_purchases" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "last_purchase_date" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "barcode_type" "BarcodeType" NOT NULL DEFAULT 'CODE128',
    "description" TEXT,
    "category_id" CHAR(24) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "supplier_id" CHAR(24),
    "current_stock" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "reserved_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_stockable" BOOLEAN NOT NULL DEFAULT true,
    "low_stock_threshold" DECIMAL(19,4) NOT NULL DEFAULT 10,
    "average_cost" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "selling_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "cost_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "last_supply_date" TIMESTAMPTZ(3),
    "last_sale_date" TIMESTAMPTZ(3),
    "costing_method" "CostingMethod" NOT NULL DEFAULT 'fifo',
    "inventory_account" TEXT,
    "cogs_account" TEXT,
    "revenue_account" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "brand" TEXT,
    "location" TEXT,
    "tracking_type" "TrackingType" NOT NULL DEFAULT 'none',
    "track_batch" BOOLEAN NOT NULL DEFAULT false,
    "track_serial_numbers" BOOLEAN NOT NULL DEFAULT false,
    "reorder_point" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "reorder_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "default_warehouse_id" CHAR(24),
    "preferred_supplier_id" CHAR(24),
    "tax_code" TEXT NOT NULL DEFAULT 'A',
    "tax_rate" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_by" CHAR(24),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chart_of_accounts" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'asset',
    "subtype" TEXT,
    "normal_balance" "NormalBalance" NOT NULL DEFAULT 'debit',
    "parent_id" CHAR(24),
    "allow_direct_posting" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxes" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "tax_type" "TaxRecordType" NOT NULL,
    "vat_rate" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "vat_output" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_input" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_period" JSONB,
    "corporate_income_rate" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "taxable_income" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_owed" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paye_collected" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paye_paid" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paye_period" JSONB,
    "withholding_collected" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "withholding_paid" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "trading_license_fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "trading_license_year" INTEGER,
    "trading_license_status" "TradingLicenseStatus" NOT NULL DEFAULT 'not_applicable',
    "payments" JSONB NOT NULL DEFAULT '[]',
    "filings" JSONB NOT NULL DEFAULT '[]',
    "calendar" JSONB NOT NULL DEFAULT '[]',
    "status" "TaxRecordStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rate_pct" DOUBLE PRECISION NOT NULL,
    "type" "TaxRateType" NOT NULL,
    "input_account_id" CHAR(24) NOT NULL,
    "output_account_id" CHAR(24) NOT NULL,
    "input_account_code" TEXT NOT NULL,
    "output_account_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "id" CHAR(24) NOT NULL,
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "decimal_places" INTEGER NOT NULL DEFAULT 2,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "from_currency" VARCHAR(3) NOT NULL,
    "to_currency" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(19,6) NOT NULL,
    "effective_date" TIMESTAMPTZ(3) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL DEFAULT 'manual',
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "manager_id" CHAR(24),
    "default_labor_account" VARCHAR(4) NOT NULL DEFAULT '5400',
    "budget_limit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_company_id_idx" ON "categories"("company_id");

-- CreateIndex
CREATE INDEX "categories_company_id_name_idx" ON "categories"("company_id", "name");

-- CreateIndex
CREATE INDEX "categories_company_id_parent_id_idx" ON "categories"("company_id", "parent_id");

-- CreateIndex
CREATE INDEX "warehouses_company_id_idx" ON "warehouses"("company_id");

-- CreateIndex
CREATE INDEX "warehouses_company_id_is_active_idx" ON "warehouses"("company_id", "is_active");

-- CreateIndex
CREATE INDEX "warehouses_company_id_rra_branch_id_idx" ON "warehouses"("company_id", "rra_branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_company_id_code_key" ON "warehouses"("company_id", "code");

-- CreateIndex
CREATE INDEX "clients_company_id_idx" ON "clients"("company_id");

-- CreateIndex
CREATE INDEX "clients_company_id_is_active_idx" ON "clients"("company_id", "is_active");

-- CreateIndex
CREATE INDEX "clients_company_id_name_idx" ON "clients"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_company_id_code_key" ON "clients"("company_id", "code");

-- CreateIndex
CREATE INDEX "suppliers_company_id_idx" ON "suppliers"("company_id");

-- CreateIndex
CREATE INDEX "suppliers_company_id_is_active_idx" ON "suppliers"("company_id", "is_active");

-- CreateIndex
CREATE INDEX "suppliers_company_id_name_idx" ON "suppliers"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_company_id_code_key" ON "suppliers"("company_id", "code");

-- CreateIndex
CREATE INDEX "products_company_id_idx" ON "products"("company_id");

-- CreateIndex
CREATE INDEX "products_company_id_category_id_idx" ON "products"("company_id", "category_id");

-- CreateIndex
CREATE INDEX "products_company_id_is_archived_idx" ON "products"("company_id", "is_archived");

-- CreateIndex
CREATE INDEX "products_company_id_is_active_idx" ON "products"("company_id", "is_active");

-- CreateIndex
CREATE INDEX "products_company_id_name_idx" ON "products"("company_id", "name");

-- CreateIndex
CREATE INDEX "products_company_id_current_stock_idx" ON "products"("company_id", "current_stock");

-- CreateIndex
CREATE INDEX "products_supplier_id_idx" ON "products"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_sku_key" ON "products"("company_id", "sku");

-- CreateIndex
CREATE INDEX "chart_of_accounts_company_id_idx" ON "chart_of_accounts"("company_id");

-- CreateIndex
CREATE INDEX "chart_of_accounts_company_id_type_idx" ON "chart_of_accounts"("company_id", "type");

-- CreateIndex
CREATE INDEX "chart_of_accounts_company_id_parent_id_idx" ON "chart_of_accounts"("company_id", "parent_id");

-- CreateIndex
CREATE INDEX "chart_of_accounts_company_id_is_active_idx" ON "chart_of_accounts"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_company_id_code_key" ON "chart_of_accounts"("company_id", "code");

-- CreateIndex
CREATE INDEX "taxes_company_id_idx" ON "taxes"("company_id");

-- CreateIndex
CREATE INDEX "taxes_company_id_tax_type_idx" ON "taxes"("company_id", "tax_type");

-- CreateIndex
CREATE INDEX "tax_rates_company_id_idx" ON "tax_rates"("company_id");

-- CreateIndex
CREATE INDEX "tax_rates_company_id_is_active_idx" ON "tax_rates"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_company_id_code_key" ON "tax_rates"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "currencies_code_key" ON "currencies"("code");

-- CreateIndex
CREATE INDEX "currencies_is_active_idx" ON "currencies"("is_active");

-- CreateIndex
CREATE INDEX "exchange_rates_company_id_from_currency_effective_date_idx" ON "exchange_rates"("company_id", "from_currency", "effective_date" DESC);

-- CreateIndex
CREATE INDEX "departments_company_id_idx" ON "departments"("company_id");

-- CreateIndex
CREATE INDEX "departments_company_id_is_active_idx" ON "departments"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "departments_company_id_code_key" ON "departments"("company_id", "code");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_preferred_supplier_id_fkey" FOREIGN KEY ("preferred_supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_default_warehouse_id_fkey" FOREIGN KEY ("default_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxes" ADD CONSTRAINT "taxes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_input_account_id_fkey" FOREIGN KEY ("input_account_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_output_account_id_fkey" FOREIGN KEY ("output_account_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
