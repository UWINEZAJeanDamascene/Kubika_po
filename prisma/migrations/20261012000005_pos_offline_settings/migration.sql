ALTER TABLE "system_settings"
  ADD COLUMN "pos_offline_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pos_offline_max_hours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "pos_offline_queue_limit" DOUBLE PRECISION NOT NULL DEFAULT 1000000,
  ADD COLUMN "pos_negative_stock_escalation_days" INTEGER NOT NULL DEFAULT 3;
