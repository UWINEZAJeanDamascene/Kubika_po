-- Step 8 — Transactions & sequences foundation
-- Atomic reference-number counters for multi-tenant document numbering.

-- CreateEnum
CREATE TYPE "EbmSequenceType" AS ENUM ('sales_invoice', 'receipt', 'report', 'stock_sar');

-- CreateTable
CREATE TABLE "sequences" (
    "company_id" CHAR(24) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "year" INTEGER NOT NULL DEFAULT 0,
    "value" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("company_id","name","year")
);

-- CreateTable
CREATE TABLE "ebm_sequences" (
    "company_id" CHAR(24) NOT NULL,
    "branch_id" VARCHAR(2) NOT NULL,
    "sequence_type" "EbmSequenceType" NOT NULL,
    "last_number" BIGINT NOT NULL DEFAULT 0,
    "seeded_from" TEXT,
    "seeded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_sequences_pkey" PRIMARY KEY ("company_id","branch_id","sequence_type")
);

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_sequences" ADD CONSTRAINT "ebm_sequences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
