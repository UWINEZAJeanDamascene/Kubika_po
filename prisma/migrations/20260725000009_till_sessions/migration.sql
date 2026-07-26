-- CreateEnum
CREATE TYPE "TillSessionStatus" AS ENUM ('open', 'closed');

-- CreateTable
CREATE TABLE "till_sessions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "opened_by" CHAR(24) NOT NULL,
    "status" "TillSessionStatus" NOT NULL DEFAULT 'open',
    "opening_float" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "closing_count" DECIMAL(19,2),
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "till_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "till_sessions_company_id_opened_by_status_idx" ON "till_sessions"("company_id", "opened_by", "status");

-- CreateIndex
CREATE INDEX "till_sessions_company_id_status_opened_at_idx" ON "till_sessions"("company_id", "status", "opened_at" DESC);

-- AddForeignKey
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
