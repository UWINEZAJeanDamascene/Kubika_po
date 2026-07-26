-- CreateTable
CREATE TABLE "ip_whitelists" (
    "id" CHAR(24) NOT NULL,
    "ip" TEXT NOT NULL,
    "company_id" CHAR(24),
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ip_whitelists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ip_whitelists_company_id_ip_key" ON "ip_whitelists"("company_id", "ip");

-- CreateIndex
CREATE INDEX "ip_whitelists_company_id_enabled_idx" ON "ip_whitelists"("company_id", "enabled");

-- CreateIndex
CREATE INDEX "ip_whitelists_ip_enabled_idx" ON "ip_whitelists"("ip", "enabled");

-- AddForeignKey
ALTER TABLE "ip_whitelists" ADD CONSTRAINT "ip_whitelists_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
