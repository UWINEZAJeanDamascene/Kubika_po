CREATE TABLE "backups" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'manual',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "storage_location" TEXT NOT NULL DEFAULT 'local',
  "cloud_url" TEXT,
  "file_path" TEXT,
  "file_size" INTEGER NOT NULL DEFAULT 0,
  "compression_format" TEXT NOT NULL DEFAULT 'gzip',
  "source_version" TEXT NOT NULL DEFAULT '',
  "point_in_time" TIMESTAMPTZ(3),
  "collections" JSONB NOT NULL DEFAULT '[]',
  "verification" JSONB NOT NULL DEFAULT '{}',
  "error_message" TEXT,
  "restore" JSONB NOT NULL DEFAULT '{}',
  "schedule" JSONB NOT NULL DEFAULT '{}',
  "retention" JSONB NOT NULL DEFAULT '{}',
  "created_by" CHAR(24),
  "cloud_config" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backups_company_created_at_idx" ON "backups"("company_id", "created_at");
CREATE INDEX "backups_company_status_idx" ON "backups"("company_id", "status");
CREATE INDEX "backups_company_type_idx" ON "backups"("company_id", "type");
