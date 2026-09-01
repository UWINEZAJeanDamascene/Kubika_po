-- CreateTable
CREATE TABLE "notifications" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(3),
    "link" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_invoice_delivery" BOOLEAN NOT NULL DEFAULT false,
    "email_payment_reminders" BOOLEAN NOT NULL DEFAULT true,
    "email_low_stock_alerts" BOOLEAN NOT NULL DEFAULT true,
    "email_daily_summary" BOOLEAN NOT NULL DEFAULT false,
    "email_weekly_summary" BOOLEAN NOT NULL DEFAULT true,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_critical_only" BOOLEAN NOT NULL DEFAULT true,
    "sms_admin_phones" TEXT[],
    "low_stock_threshold" DECIMAL(19,4) NOT NULL DEFAULT 10,
    "payment_reminder_days" INTEGER NOT NULL DEFAULT 3,
    "summary_send_time" TEXT NOT NULL DEFAULT '09:00',
    "large_order_threshold" DECIMAL(19,4) NOT NULL DEFAULT 10000,
    "critical_alert_phones" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_company_id_user_id_is_read_created_at_idx" ON "notifications"("company_id", "user_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_company_id_created_at_idx" ON "notifications"("company_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_company_id_key" ON "notification_settings"("company_id");

-- CreateIndex
CREATE INDEX "products_company_id_is_archived_is_active_idx" ON "products"("company_id", "is_archived", "is_active");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
