-- CreateTable
CREATE TABLE "invoice_receipt_metadata" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "invoice_id" CHAR(24) NOT NULL,
    "sdc_id" TEXT,
    "receipt_number" TEXT,
    "receipt_signature" TEXT,
    "internal_data" TEXT,
    "mrc_code" TEXT,
    "device_id" TEXT,
    "fiscal_date" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_receipt_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_receipt_metadata_company_id_invoice_id_idx" ON "invoice_receipt_metadata"("company_id", "invoice_id");

-- CreateIndex
CREATE INDEX "invoice_receipt_metadata_company_id_receipt_number_idx" ON "invoice_receipt_metadata"("company_id", "receipt_number");

-- AddForeignKey
ALTER TABLE "invoice_receipt_metadata" ADD CONSTRAINT "invoice_receipt_metadata_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_receipt_metadata" ADD CONSTRAINT "invoice_receipt_metadata_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
