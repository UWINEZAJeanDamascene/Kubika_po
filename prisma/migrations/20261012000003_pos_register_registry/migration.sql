CREATE TABLE "pos_registers" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "location" VARCHAR(160),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "claimed_device_id" VARCHAR(80),
    "claimed_at" TIMESTAMPTZ(3),
    "claim_code_hash" VARCHAR(64),
    "claim_expires_at" TIMESTAMPTZ(3),
    "created_by_id" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pos_registers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pos_registers_company_id_code_key" ON "pos_registers"("company_id", "code");
CREATE UNIQUE INDEX "pos_registers_company_id_claimed_device_id_key" ON "pos_registers"("company_id", "claimed_device_id");
CREATE INDEX "pos_registers_company_id_is_active_idx" ON "pos_registers"("company_id", "is_active");

ALTER TABLE "pos_registers"
ADD CONSTRAINT "pos_registers_company_id_fkey"
FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve historical register labels so existing shift and Z-report history remains readable.
INSERT INTO "pos_registers" ("id", "company_id", "code", "name", "is_active", "created_at", "updated_at")
SELECT SUBSTRING(MD5(ts."company_id" || ':' || ts."register_id"), 1, 24),
       ts."company_id",
       LEFT(ts."register_id", 80),
       LEFT(COALESCE(NULLIF(ts."register_name", ''), 'Legacy Register'), 120),
       CASE WHEN ts."register_id" LIKE 'reg-%' THEN BOOL_OR(ts."status" = 'open') ELSE true END,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "till_sessions" ts
 WHERE ts."register_id" IS NOT NULL
 GROUP BY ts."company_id", ts."register_id", ts."register_name"
ON CONFLICT ("company_id", "code") DO NOTHING;
