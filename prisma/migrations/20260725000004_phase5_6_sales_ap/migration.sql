-- CreateTable
CREATE TABLE "quotations" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "quotation_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiry_date" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "base_currency" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "subtotal_base" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount_base" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "terms" TEXT,
    "notes" TEXT,
    "customer_action" JSONB NOT NULL DEFAULT '{}',
    "converted_to_invoice_id" CHAR(24),
    "converted_to_sales_order_id" CHAR(24),
    "conversion_date" TIMESTAMPTZ(3),
    "approved_by" CHAR(24),
    "approved_date" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "quotation_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "line_id" TEXT,
    "product_id" CHAR(24) NOT NULL,
    "product_name" TEXT,
    "product_sku" TEXT,
    "product_unit" TEXT,
    "description" TEXT,
    "qty" DECIMAL(19,4) NOT NULL,
    "unit" TEXT,
    "unit_price" DECIMAL(19,6) NOT NULL,
    "discount_pct" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_discount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_tax" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "extra" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "quotation_id" CHAR(24),
    "order_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_date" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "fulfillment_status" TEXT NOT NULL DEFAULT 'pending',
    "fulfillment_percent" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "stock_reserved" BOOLEAN NOT NULL DEFAULT false,
    "is_backorder" BOOLEAN NOT NULL DEFAULT false,
    "parent_order_id" CHAR(24),
    "delivery_notes" JSONB NOT NULL DEFAULT '[]',
    "invoices" JSONB NOT NULL DEFAULT '[]',
    "pick_pack_id" CHAR(24),
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "sales_order_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "line_id" TEXT,
    "product_id" CHAR(24) NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(19,4) NOT NULL,
    "qty_reserved" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "qty_picked" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "qty_delivered" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "qty_invoiced" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "unit" TEXT,
    "unit_price" DECIMAL(19,6) NOT NULL,
    "discount_pct" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_tax" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "warehouse_id" CHAR(24),
    "batch_id" CHAR(24),
    "serial_numbers" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "traceability" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "customer_tin" TEXT,
    "customer_name" TEXT,
    "customer_address" TEXT,
    "quotation_id" CHAR(24),
    "sales_order_id" CHAR(24),
    "delivery_note_id" CHAR(24),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "amount_outstanding" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_a_ex" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_b18" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "invoice_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" TIMESTAMPTZ(3) NOT NULL,
    "paid_date" TIMESTAMPTZ(3),
    "revenue_journal_entry_id" CHAR(24),
    "cogs_journal_entry_id" CHAR(24),
    "stock_deducted" BOOLEAN NOT NULL DEFAULT false,
    "auto_confirm" BOOLEAN NOT NULL DEFAULT false,
    "generated_from_recurring_id" CHAR(24),
    "payments" JSONB NOT NULL DEFAULT '[]',
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "invoice_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "line_id" CHAR(24),
    "product_id" CHAR(24) NOT NULL,
    "product_name" TEXT,
    "product_code" TEXT,
    "description" TEXT,
    "qty" DECIMAL(19,4) NOT NULL,
    "unit" TEXT,
    "unit_price" DECIMAL(19,6) NOT NULL,
    "discount_pct" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_code" TEXT NOT NULL DEFAULT 'A',
    "line_subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_tax" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "cogs_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "warehouse_id" CHAR(24),
    "qty_credited" DECIMAL(19,4) NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "invoice_id" CHAR(24) NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "credit_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "type" TEXT NOT NULL DEFAULT 'return',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "revenue_reversal_entry_id" CHAR(24),
    "cogs_reversal_entry_id" CHAR(24),
    "stock_reversed" BOOLEAN NOT NULL DEFAULT false,
    "payments" JSONB NOT NULL DEFAULT '[]',
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24),
    "confirmed_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "credit_note_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "invoice_line_id" CHAR(24),
    "product_id" CHAR(24) NOT NULL,
    "product_name" TEXT,
    "quantity" DECIMAL(19,4) NOT NULL,
    "original_qty" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(19,6) NOT NULL,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "return_to_warehouse_id" CHAR(24),
    "batch_id" CHAR(24),
    "serial_numbers" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_notes" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "sales_order_id" CHAR(24),
    "pick_pack_id" CHAR(24),
    "invoice_id" CHAR(24),
    "client_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "quotation_id" CHAR(24),
    "source_type" TEXT,
    "delivery_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stock_deducted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_note_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "delivery_note_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "invoice_line_id" CHAR(24),
    "product_id" CHAR(24) NOT NULL,
    "product_name" TEXT,
    "product_code" TEXT,
    "unit" TEXT,
    "qty_to_deliver" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "delivered_qty" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "batch_id" CHAR(24),
    "serial_numbers" JSONB NOT NULL DEFAULT '[]',
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "delivery_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_receipts" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "receipt_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_method" TEXT NOT NULL,
    "bank_account_id" CHAR(24),
    "amount_received" DECIMAL(19,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "journal_entry_id" CHAR(24),
    "reverse_journal_entry_id" CHAR(24),
    "unallocated_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "posted_by" CHAR(24),
    "posted_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ar_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_receipt_allocations" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "receipt_id" CHAR(24) NOT NULL,
    "invoice_id" CHAR(24) NOT NULL,
    "amount_allocated" DECIMAL(19,2) NOT NULL,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ar_receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_invoices" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "next_run_date" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "auto_confirm" BOOLEAN NOT NULL DEFAULT false,
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "notes" TEXT,
    "last_run_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurring_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_invoice_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "recurring_invoice_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "product_id" CHAR(24) NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(19,4) NOT NULL,
    "unit_price" DECIMAL(19,6) NOT NULL,
    "discount_pct" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "warehouse_id" CHAR(24),

    CONSTRAINT "recurring_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_invoice_runs" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "recurring_invoice_id" CHAR(24) NOT NULL,
    "run_date" TIMESTAMPTZ(3) NOT NULL,
    "invoice_id" CHAR(24),
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_invoice_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24),
    "order_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_delivery_date" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "auto_reorder_product_id" CHAR(24),
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "payment_status" TEXT NOT NULL DEFAULT 'unpaid',
    "payments" JSONB NOT NULL DEFAULT '[]',
    "freight" JSONB NOT NULL DEFAULT '{}',
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "purchase_order_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "product_id" CHAR(24) NOT NULL,
    "qty_ordered" DECIMAL(19,4) NOT NULL,
    "qty_received" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "budget_refs" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "purchase_number" TEXT NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "supplier_invoice_number" TEXT,
    "supplier_invoice_date" TIMESTAMPTZ(3),
    "warehouse_id" CHAR(24),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "payment_terms" TEXT,
    "subtotal" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "payments" JSONB NOT NULL DEFAULT '[]',
    "purchase_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stock_added" BOOLEAN NOT NULL DEFAULT false,
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "supplier_snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "purchase_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "product_id" CHAR(24) NOT NULL,
    "qty" DECIMAL(19,4) NOT NULL,
    "unit_cost" DECIMAL(19,6) NOT NULL,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "extra" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_received_notes" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "purchase_order_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "received_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "supplier_invoice_no" TEXT,
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "payment_status" TEXT NOT NULL DEFAULT 'pending',
    "payment_due_date" TIMESTAMPTZ(3),
    "journal_entry_id" CHAR(24),
    "freight" JSONB NOT NULL DEFAULT '{}',
    "ebm" JSONB NOT NULL DEFAULT '{}',
    "ebm_import_reference" TEXT,
    "created_by" CHAR(24),
    "confirmed_by" CHAR(24),
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goods_received_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "grn_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "purchase_order_line_id" CHAR(24),
    "product_id" CHAR(24) NOT NULL,
    "qty_received" DECIMAL(19,4) NOT NULL,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "batch_no" TEXT,
    "serial_numbers" JSONB NOT NULL DEFAULT '[]',
    "extra" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "grn_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "grn_id" CHAR(24) NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "return_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "journal_entry_id" CHAR(24),
    "refund_method" TEXT,
    "bank_account_id" CHAR(24),
    "refund_journal_entry_id" CHAR(24),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "purchase_return_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "grn_line_id" CHAR(24),
    "product_id" CHAR(24) NOT NULL,
    "qty_returned" DECIMAL(19,4) NOT NULL,
    "unit_cost" DECIMAL(19,6) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_payments" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "supplier_id" CHAR(24) NOT NULL,
    "payment_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_method" TEXT NOT NULL,
    "bank_account_id" CHAR(24),
    "amount_paid" DECIMAL(19,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'RWF',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "journal_entry_id" CHAR(24),
    "reverse_journal_entry_id" CHAR(24),
    "unallocated_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ap_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_payment_allocations" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "payment_id" CHAR(24) NOT NULL,
    "grn_id" CHAR(24) NOT NULL,
    "amount_allocated" DECIMAL(19,2) NOT NULL,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ap_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freight_bills" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "supplier_id" CHAR(24),
    "carrier_name" TEXT,
    "amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "account" TEXT,
    "invoice_date" TIMESTAMPTZ(3),
    "payment_method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "grn_matches" JSONB NOT NULL DEFAULT '[]',
    "journal_entry_id" CHAR(24),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "freight_bills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotations_company_id_status_idx" ON "quotations"("company_id", "status");

-- CreateIndex
CREATE INDEX "quotations_company_id_expiry_date_idx" ON "quotations"("company_id", "expiry_date");

-- CreateIndex
CREATE INDEX "quotations_client_id_idx" ON "quotations"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_company_id_reference_no_key" ON "quotations"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "quotation_lines_quotation_id_idx" ON "quotation_lines"("quotation_id");

-- CreateIndex
CREATE INDEX "quotation_lines_company_id_product_id_idx" ON "quotation_lines"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "sales_orders_company_id_status_idx" ON "sales_orders"("company_id", "status");

-- CreateIndex
CREATE INDEX "sales_orders_company_id_order_date_idx" ON "sales_orders"("company_id", "order_date" DESC);

-- CreateIndex
CREATE INDEX "sales_orders_company_id_client_id_idx" ON "sales_orders"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "sales_orders_quotation_id_idx" ON "sales_orders"("quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_company_id_reference_no_key" ON "sales_orders"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "sales_order_lines_sales_order_id_idx" ON "sales_order_lines"("sales_order_id");

-- CreateIndex
CREATE INDEX "sales_order_lines_company_id_product_id_idx" ON "sales_order_lines"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "invoices_company_id_status_due_date_idx" ON "invoices"("company_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "invoices_company_id_invoice_date_idx" ON "invoices"("company_id", "invoice_date" DESC);

-- CreateIndex
CREATE INDEX "invoices_company_id_client_id_status_idx" ON "invoices"("company_id", "client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_company_id_reference_no_key" ON "invoices"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_lines_company_id_product_id_idx" ON "invoice_lines"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "credit_notes_company_id_status_idx" ON "credit_notes"("company_id", "status");

-- CreateIndex
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes"("invoice_id");

-- CreateIndex
CREATE INDEX "credit_notes_credit_date_idx" ON "credit_notes"("credit_date");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_company_id_reference_no_key" ON "credit_notes"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "credit_note_lines_credit_note_id_idx" ON "credit_note_lines"("credit_note_id");

-- CreateIndex
CREATE INDEX "delivery_notes_company_id_status_idx" ON "delivery_notes"("company_id", "status");

-- CreateIndex
CREATE INDEX "delivery_notes_invoice_id_idx" ON "delivery_notes"("invoice_id");

-- CreateIndex
CREATE INDEX "delivery_notes_warehouse_id_idx" ON "delivery_notes"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_notes_company_id_reference_no_key" ON "delivery_notes"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "delivery_note_lines_delivery_note_id_idx" ON "delivery_note_lines"("delivery_note_id");

-- CreateIndex
CREATE INDEX "ar_receipts_company_id_client_id_idx" ON "ar_receipts"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "ar_receipts_company_id_receipt_date_idx" ON "ar_receipts"("company_id", "receipt_date");

-- CreateIndex
CREATE INDEX "ar_receipts_company_id_status_idx" ON "ar_receipts"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ar_receipts_company_id_reference_no_key" ON "ar_receipts"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "ar_receipt_allocations_company_id_invoice_id_idx" ON "ar_receipt_allocations"("company_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "ar_receipt_allocations_receipt_id_invoice_id_key" ON "ar_receipt_allocations"("receipt_id", "invoice_id");

-- CreateIndex
CREATE INDEX "recurring_invoices_company_id_status_idx" ON "recurring_invoices"("company_id", "status");

-- CreateIndex
CREATE INDEX "recurring_invoices_company_id_next_run_date_idx" ON "recurring_invoices"("company_id", "next_run_date");

-- CreateIndex
CREATE INDEX "recurring_invoice_lines_recurring_invoice_id_idx" ON "recurring_invoice_lines"("recurring_invoice_id");

-- CreateIndex
CREATE INDEX "recurring_invoice_runs_company_id_run_date_idx" ON "recurring_invoice_runs"("company_id", "run_date");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_invoice_runs_recurring_invoice_id_run_date_key" ON "recurring_invoice_runs"("recurring_invoice_id", "run_date");

-- CreateIndex
CREATE INDEX "purchase_orders_company_id_status_order_date_idx" ON "purchase_orders"("company_id", "status", "order_date");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_company_id_reference_no_key" ON "purchase_orders"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchase_order_id_idx" ON "purchase_order_lines"("purchase_order_id");

-- CreateIndex
CREATE INDEX "purchases_company_id_status_idx" ON "purchases"("company_id", "status");

-- CreateIndex
CREATE INDEX "purchases_company_id_purchase_date_idx" ON "purchases"("company_id", "purchase_date" DESC);

-- CreateIndex
CREATE INDEX "purchases_company_id_supplier_id_idx" ON "purchases"("company_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_company_id_purchase_number_key" ON "purchases"("company_id", "purchase_number");

-- CreateIndex
CREATE INDEX "purchase_lines_purchase_id_idx" ON "purchase_lines"("purchase_id");

-- CreateIndex
CREATE INDEX "goods_received_notes_company_id_payment_status_payment_due__idx" ON "goods_received_notes"("company_id", "payment_status", "payment_due_date");

-- CreateIndex
CREATE INDEX "goods_received_notes_purchase_order_id_idx" ON "goods_received_notes"("purchase_order_id");

-- CreateIndex
CREATE INDEX "goods_received_notes_supplier_id_idx" ON "goods_received_notes"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_received_notes_company_id_reference_no_key" ON "goods_received_notes"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "grn_lines_grn_id_idx" ON "grn_lines"("grn_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_company_id_reference_no_key" ON "purchase_returns"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "purchase_return_lines_purchase_return_id_idx" ON "purchase_return_lines"("purchase_return_id");

-- CreateIndex
CREATE INDEX "ap_payments_company_id_supplier_id_idx" ON "ap_payments"("company_id", "supplier_id");

-- CreateIndex
CREATE INDEX "ap_payments_company_id_payment_date_idx" ON "ap_payments"("company_id", "payment_date");

-- CreateIndex
CREATE INDEX "ap_payments_company_id_status_idx" ON "ap_payments"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ap_payments_company_id_reference_no_key" ON "ap_payments"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "ap_payment_allocations_grn_id_idx" ON "ap_payment_allocations"("grn_id");

-- CreateIndex
CREATE UNIQUE INDEX "ap_payment_allocations_payment_id_grn_id_key" ON "ap_payment_allocations"("payment_id", "grn_id");

-- CreateIndex
CREATE UNIQUE INDEX "freight_bills_company_id_reference_no_key" ON "freight_bills"("company_id", "reference_no");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_delivery_note_id_fkey" FOREIGN KEY ("delivery_note_id") REFERENCES "delivery_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_receipts" ADD CONSTRAINT "ar_receipts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_receipts" ADD CONSTRAINT "ar_receipts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_receipt_allocations" ADD CONSTRAINT "ar_receipt_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_receipt_allocations" ADD CONSTRAINT "ar_receipt_allocations_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "ar_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_receipt_allocations" ADD CONSTRAINT "ar_receipt_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_recurring_invoice_id_fkey" FOREIGN KEY ("recurring_invoice_id") REFERENCES "recurring_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice_runs" ADD CONSTRAINT "recurring_invoice_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice_runs" ADD CONSTRAINT "recurring_invoice_runs_recurring_invoice_id_fkey" FOREIGN KEY ("recurring_invoice_id") REFERENCES "recurring_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "goods_received_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "goods_received_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_purchase_return_id_fkey" FOREIGN KEY ("purchase_return_id") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "ap_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_grn_id_fkey" FOREIGN KEY ("grn_id") REFERENCES "goods_received_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_bills" ADD CONSTRAINT "freight_bills_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
