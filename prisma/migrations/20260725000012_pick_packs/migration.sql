-- CreateTable
CREATE TABLE "pick_packs" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "sales_order_id" CHAR(24) NOT NULL,
    "client_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "assigned_to" CHAR(24),
    "assigned_at" TIMESTAMPTZ(3),
    "picking_started_at" TIMESTAMPTZ(3),
    "picking_completed_at" TIMESTAMPTZ(3),
    "packing_started_at" TIMESTAMPTZ(3),
    "packing_completed_at" TIMESTAMPTZ(3),
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "notes" TEXT,
    "package_count" INTEGER NOT NULL DEFAULT 0,
    "package_type" TEXT NOT NULL DEFAULT 'box',
    "total_weight" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "shipping_method" TEXT,
    "tracking_number" TEXT,
    "delivery_note_id" CHAR(24),
    "created_by" CHAR(24),
    "cancelled_by" CHAR(24),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pick_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_pack_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "pick_pack_id" CHAR(24) NOT NULL,
    "line_order" INTEGER NOT NULL DEFAULT 0,
    "sales_order_line_id" TEXT NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "warehouse_id" CHAR(24),
    "location" TEXT,
    "qty_to_pick" DECIMAL(19,4) NOT NULL,
    "qty_picked" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "qty_packed" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "batch_id" CHAR(24),
    "batch_no" TEXT,
    "serial_numbers" JSONB NOT NULL DEFAULT '[]',
    "unit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "picked_by" CHAR(24),
    "picked_at" TIMESTAMPTZ(3),
    "picking_notes" TEXT,
    "packed_by" CHAR(24),
    "packed_at" TIMESTAMPTZ(3),
    "packing_notes" TEXT,
    "issues" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "pick_pack_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pick_packs_company_id_reference_no_key" ON "pick_packs"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "pick_packs_company_id_status_idx" ON "pick_packs"("company_id", "status");

-- CreateIndex
CREATE INDEX "pick_packs_company_id_sales_order_id_idx" ON "pick_packs"("company_id", "sales_order_id");

-- CreateIndex
CREATE INDEX "pick_packs_company_id_client_id_idx" ON "pick_packs"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "pick_packs_company_id_assigned_to_idx" ON "pick_packs"("company_id", "assigned_to");

-- CreateIndex
CREATE INDEX "pick_packs_company_id_warehouse_id_idx" ON "pick_packs"("company_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "pick_packs_status_priority_idx" ON "pick_packs"("status", "priority");

-- CreateIndex
CREATE INDEX "pick_pack_lines_pick_pack_id_idx" ON "pick_pack_lines"("pick_pack_id");

-- CreateIndex
CREATE INDEX "pick_pack_lines_company_id_product_id_idx" ON "pick_pack_lines"("company_id", "product_id");

-- AddForeignKey
ALTER TABLE "pick_packs" ADD CONSTRAINT "pick_packs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_packs" ADD CONSTRAINT "pick_packs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_packs" ADD CONSTRAINT "pick_packs_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_pack_lines" ADD CONSTRAINT "pick_pack_lines_pick_pack_id_fkey" FOREIGN KEY ("pick_pack_id") REFERENCES "pick_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_pack_lines" ADD CONSTRAINT "pick_pack_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_pack_lines" ADD CONSTRAINT "pick_pack_lines_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_pack_lines" ADD CONSTRAINT "pick_pack_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
