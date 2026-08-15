-- Platform subscription package catalog (pricing tiers for signup/pricing/admin)

CREATE TABLE "subscription_plan_catalog" (
    "id" CHAR(24) NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outcomes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "badge" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL DEFAULT '',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "button_label" TEXT NOT NULL DEFAULT '',
    "default_billing_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "default_billing_cycle" "BillingCycle" NOT NULL DEFAULT 'monthly',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_plan_catalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_plan_catalog_key_key" ON "subscription_plan_catalog"("key");

CREATE INDEX "subscription_plan_catalog_is_active_idx" ON "subscription_plan_catalog"("is_active");

CREATE INDEX "subscription_plan_catalog_sort_order_idx" ON "subscription_plan_catalog"("sort_order");
