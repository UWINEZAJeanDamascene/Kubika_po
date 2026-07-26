-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('in', 'out', 'adjustment');

-- CreateEnum
CREATE TYPE "StockMovementReason" AS ENUM ('purchase', 'sale', 'return', 'damage', 'loss', 'theft', 'expired', 'transfer_in', 'transfer_out', 'correction', 'initial_stock', 'audit_surplus', 'audit_shortage', 'dispatch', 'dispatch_reversal');

-- CreateEnum
CREATE TYPE "InventoryBatchStatus" AS ENUM ('active', 'partially_used', 'exhausted', 'expired', 'quarantined');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('draft', 'pending', 'in_transit', 'confirmed', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "StockTransferReason" AS ENUM ('rebalance', 'sale', 'return', 'repair', 'consignment', 'other');

-- CreateEnum
CREATE TYPE "StockAuditStatus" AS ENUM ('draft', 'counting', 'posted', 'cancelled');

-- CreateEnum
CREATE TYPE "StockAuditType" AS ENUM ('full', 'partial', 'cycle_count', 'spot_check');

-- CreateEnum
CREATE TYPE "StockSerialStatus" AS ENUM ('in_stock', 'reserved', 'dispatched', 'returned', 'scrapped');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('draft', 'posted', 'voided', 'reversed');

-- CreateEnum
CREATE TYPE "JournalReconciliationStatus" AS ENUM ('unreconciled', 'reconciled', 'adjusting_entry');

-- CreateEnum
CREATE TYPE "AccountingPeriodType" AS ENUM ('month', 'quarter', 'year');

-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('open', 'closed', 'locked');

-- CreateEnum
CREATE TYPE "LegacyPeriodStatus" AS ENUM ('open', 'closed');

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "qty_on_hand" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "qty_reserved" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "qty_on_order" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "avg_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "total_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "last_counted_at" TIMESTAMPTZ(3),
    "last_counted_by" CHAR(24),
    "last_movement_at" TIMESTAMPTZ(3),
    "last_movement_type" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24),
    "type" "StockMovementType" NOT NULL,
    "reason" "StockMovementReason" NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "previous_stock" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "new_stock" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "supplier_id" CHAR(24),
    "warehouse_id" CHAR(24),
    "batch_number" TEXT,
    "lot_number" TEXT,
    "expiry_date" TIMESTAMPTZ(3),
    "reference_type" TEXT,
    "reference_number" TEXT,
    "reference_document_id" CHAR(24),
    "reference_model" TEXT,
    "notes" TEXT,
    "performed_by" CHAR(24),
    "movement_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "batch_number" TEXT,
    "lot_number" TEXT,
    "expiry_date" TIMESTAMPTZ(3),
    "quantity" DECIMAL(19,4) NOT NULL,
    "available_quantity" DECIMAL(19,4) NOT NULL,
    "reserved_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "supplier_id" CHAR(24),
    "stock_movement_id" CHAR(24),
    "manufacturing_date" TIMESTAMPTZ(3),
    "notes" TEXT,
    "status" "InventoryBatchStatus" NOT NULL DEFAULT 'active',
    "received_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_layers" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24),
    "qty_received" DECIMAL(19,4) NOT NULL,
    "qty_remaining" DECIMAL(19,4) NOT NULL,
    "unit_cost" DECIMAL(19,6) NOT NULL,
    "receipt_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" TEXT,
    "source_id" CHAR(24),
    "origin_transfer_id" CHAR(24),
    "origin_qty" DECIMAL(19,4),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_layers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "transfer_number" TEXT NOT NULL,
    "from_warehouse_id" CHAR(24) NOT NULL,
    "to_warehouse_id" CHAR(24) NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'draft',
    "transfer_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_date" TIMESTAMPTZ(3),
    "reason" "StockTransferReason" NOT NULL DEFAULT 'rebalance',
    "notes" TEXT,
    "confirmed_by" CHAR(24),
    "confirmed_at" TIMESTAMPTZ(3),
    "received_by" CHAR(24),
    "received_date" TIMESTAMPTZ(3),
    "received_notes" TEXT,
    "reference_number" TEXT,
    "signatures" JSONB NOT NULL DEFAULT '[]',
    "journal_entry_id" CHAR(24),
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "transfer_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "qty" DECIMAL(19,4) NOT NULL,
    "unit_cost" DECIMAL(19,6),
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_audits" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "audit_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "StockAuditStatus" NOT NULL DEFAULT 'draft',
    "total_variance_value" TEXT NOT NULL DEFAULT '0',
    "notes" TEXT,
    "posted_by" CHAR(24),
    "posted_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24) NOT NULL,
    "type" "StockAuditType" NOT NULL DEFAULT 'cycle_count',
    "category_id" CHAR(24),
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "items_counted" INTEGER NOT NULL DEFAULT 0,
    "items_with_variance" INTEGER NOT NULL DEFAULT 0,
    "journal_entry_id" CHAR(24),
    "approved_by" CHAR(24),
    "approved_date" TIMESTAMPTZ(3),
    "start_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_date" TIMESTAMPTZ(3),
    "due_date" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_audit_lines" (
    "id" CHAR(24) NOT NULL,
    "audit_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "qty_system" TEXT NOT NULL DEFAULT '0',
    "qty_counted" TEXT,
    "qty_variance" TEXT NOT NULL DEFAULT '0',
    "unit_cost" TEXT NOT NULL DEFAULT '0',
    "variance_value" TEXT NOT NULL DEFAULT '0',
    "journal_entry_id" CHAR(24),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_audit_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reorder_points" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "reorder_point" DECIMAL(19,4) NOT NULL,
    "reorder_quantity" DECIMAL(19,4) NOT NULL,
    "safety_stock" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "max_stock" DECIMAL(19,4),
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "estimated_unit_cost" DECIMAL(19,6),
    "auto_reorder" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_reorder_date" TIMESTAMPTZ(3),
    "last_reorder_quantity" DECIMAL(19,4),
    "last_reorder_price" DECIMAL(19,2),
    "next_reorder_date" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reorder_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_batches" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "batch_no" TEXT NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "grn_id" CHAR(24),
    "qty_received" DECIMAL(19,4) NOT NULL,
    "qty_on_hand" DECIMAL(19,4) NOT NULL,
    "unit_cost" DECIMAL(19,6) NOT NULL,
    "manufacture_date" TIMESTAMPTZ(3),
    "expiry_date" TIMESTAMPTZ(3),
    "is_quarantined" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_serial_numbers" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "serial_no" TEXT NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "grn_id" CHAR(24),
    "batch_id" CHAR(24),
    "unit_cost" DECIMAL(19,6) NOT NULL,
    "status" "StockSerialStatus" NOT NULL DEFAULT 'in_stock',
    "dispatched_via" CHAR(24),
    "returned_via" CHAR(24),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_serial_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "entry_number" TEXT NOT NULL,
    "date" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "source_type" TEXT,
    "source_id" TEXT,
    "source_reference" TEXT,
    "reference" TEXT,
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'draft',
    "total_debit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_credit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "debit_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "credit_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "is_auto_generated" BOOLEAN NOT NULL DEFAULT false,
    "reversal_of_id" CHAR(24),
    "created_by" CHAR(24) NOT NULL,
    "posted_by" CHAR(24),
    "notes" TEXT,
    "reversed" BOOLEAN NOT NULL DEFAULT false,
    "reconciliation_status" "JournalReconciliationStatus" NOT NULL DEFAULT 'unreconciled',
    "reconciled_at" TIMESTAMPTZ(3),
    "reconciled_in_reconciliation_id" CHAR(24),
    "reconciled_by" CHAR(24),
    "is_reconciliation_adjusting_entry" BOOLEAN NOT NULL DEFAULT false,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by" CHAR(24),
    "reversal_entry_id" CHAR(24),
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" CHAR(24),
    "locked_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "journal_entry_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "account_code" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "matched_statement_line_id" CHAR(24),
    "account_id" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "journal_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balances" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "account_code" TEXT NOT NULL,
    "debit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mappings" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "module" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "account_code" JSONB NOT NULL,
    "description" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "period_type" "AccountingPeriodType" NOT NULL DEFAULT 'month',
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'open',
    "closed_by" CHAR(24),
    "closed_at" TIMESTAMPTZ(3),
    "year_end_close_entry_id" CHAR(24),
    "is_year_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "periods" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT,
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3) NOT NULL,
    "status" "LegacyPeriodStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_levels_company_id_warehouse_id_idx" ON "stock_levels"("company_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_levels_company_id_qty_on_hand_idx" ON "stock_levels"("company_id", "qty_on_hand");

-- CreateIndex
CREATE INDEX "stock_levels_company_id_last_movement_at_idx" ON "stock_levels"("company_id", "last_movement_at");

-- CreateIndex
CREATE INDEX "stock_levels_company_id_product_id_idx" ON "stock_levels"("company_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_company_id_product_id_warehouse_id_key" ON "stock_levels"("company_id", "product_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_movements_company_id_movement_date_idx" ON "stock_movements"("company_id", "movement_date" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_company_id_product_id_movement_date_idx" ON "stock_movements"("company_id", "product_id", "movement_date" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_company_id_type_reason_movement_date_idx" ON "stock_movements"("company_id", "type", "reason", "movement_date");

-- CreateIndex
CREATE INDEX "stock_movements_company_id_type_created_at_idx" ON "stock_movements"("company_id", "type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_batches_company_id_product_id_idx" ON "inventory_batches"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_batches_company_id_warehouse_id_product_id_status_idx" ON "inventory_batches"("company_id", "warehouse_id", "product_id", "status");

-- CreateIndex
CREATE INDEX "inventory_batches_company_id_status_expiry_date_idx" ON "inventory_batches"("company_id", "status", "expiry_date");

-- CreateIndex
CREATE INDEX "inventory_batches_company_id_batch_number_idx" ON "inventory_batches"("company_id", "batch_number");

-- CreateIndex
CREATE INDEX "inventory_layers_company_id_product_id_warehouse_id_receipt_idx" ON "inventory_layers"("company_id", "product_id", "warehouse_id", "receipt_date");

-- CreateIndex
CREATE INDEX "stock_transfers_company_id_status_created_at_idx" ON "stock_transfers"("company_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_transfers_from_warehouse_id_status_idx" ON "stock_transfers"("from_warehouse_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_to_warehouse_id_status_idx" ON "stock_transfers"("to_warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_company_id_transfer_number_key" ON "stock_transfers"("company_id", "transfer_number");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_transfer_id_idx" ON "stock_transfer_lines"("transfer_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_company_id_transfer_id_idx" ON "stock_transfer_lines"("company_id", "transfer_id");

-- CreateIndex
CREATE INDEX "stock_audits_company_id_status_audit_date_idx" ON "stock_audits"("company_id", "status", "audit_date" DESC);

-- CreateIndex
CREATE INDEX "stock_audits_warehouse_id_status_idx" ON "stock_audits"("warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_audits_company_id_reference_no_key" ON "stock_audits"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "stock_audit_lines_audit_id_idx" ON "stock_audit_lines"("audit_id");

-- CreateIndex
CREATE INDEX "stock_audit_lines_product_id_idx" ON "stock_audit_lines"("product_id");

-- CreateIndex
CREATE INDEX "reorder_points_company_id_supplier_id_idx" ON "reorder_points"("company_id", "supplier_id");

-- CreateIndex
CREATE INDEX "reorder_points_company_id_is_active_idx" ON "reorder_points"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "reorder_points_company_id_product_id_key" ON "reorder_points"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_batches_company_id_product_id_idx" ON "stock_batches"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_batches_company_id_warehouse_id_idx" ON "stock_batches"("company_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_batches_company_id_expiry_date_idx" ON "stock_batches"("company_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_batches_batch_no_product_id_warehouse_id_key" ON "stock_batches"("batch_no", "product_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_serial_numbers_company_id_product_id_status_idx" ON "stock_serial_numbers"("company_id", "product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_serial_numbers_product_id_serial_no_key" ON "stock_serial_numbers"("product_id", "serial_no");

-- CreateIndex
CREATE INDEX "journal_entries_company_id_date_entry_number_idx" ON "journal_entries"("company_id", "date" DESC, "entry_number" DESC);

-- CreateIndex
CREATE INDEX "journal_entries_company_id_status_date_idx" ON "journal_entries"("company_id", "status", "date");

-- CreateIndex
CREATE INDEX "journal_entries_company_id_source_type_date_idx" ON "journal_entries"("company_id", "source_type", "date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_company_id_entry_number_key" ON "journal_entries"("company_id", "entry_number");

-- CreateIndex
CREATE INDEX "journal_entry_lines_company_id_account_code_idx" ON "journal_entry_lines"("company_id", "account_code");

-- CreateIndex
CREATE INDEX "journal_entry_lines_journal_entry_id_idx" ON "journal_entry_lines"("journal_entry_id");

-- CreateIndex
CREATE INDEX "journal_entry_lines_company_id_account_id_idx" ON "journal_entry_lines"("company_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_balances_company_id_account_code_key" ON "account_balances"("company_id", "account_code");

-- CreateIndex
CREATE UNIQUE INDEX "account_mappings_company_id_module_key_key" ON "account_mappings"("company_id", "module", "key");

-- CreateIndex
CREATE INDEX "accounting_periods_company_id_status_idx" ON "accounting_periods"("company_id", "status");

-- CreateIndex
CREATE INDEX "accounting_periods_company_id_fiscal_year_idx" ON "accounting_periods"("company_id", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_company_id_start_date_end_date_key" ON "accounting_periods"("company_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "periods_company_id_start_date_end_date_idx" ON "periods"("company_id", "start_date", "end_date");

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_warehouse_id_fkey" FOREIGN KEY ("from_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_warehouse_id_fkey" FOREIGN KEY ("to_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_lines" ADD CONSTRAINT "stock_audit_lines_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "stock_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_lines" ADD CONSTRAINT "stock_audit_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_points" ADD CONSTRAINT "reorder_points_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_points" ADD CONSTRAINT "reorder_points_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_points" ADD CONSTRAINT "reorder_points_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_serial_numbers" ADD CONSTRAINT "stock_serial_numbers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_serial_numbers" ADD CONSTRAINT "stock_serial_numbers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_serial_numbers" ADD CONSTRAINT "stock_serial_numbers_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_serial_numbers" ADD CONSTRAINT "stock_serial_numbers_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "periods" ADD CONSTRAINT "periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
