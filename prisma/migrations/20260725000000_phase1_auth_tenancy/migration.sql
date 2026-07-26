-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CompanyApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('starter', 'professional', 'enterprise');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'past_due', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('monthly', 'quarterly', 'annual');

-- CreateEnum
CREATE TYPE "CompanyUserStatus" AS ENUM ('active', 'inactive', 'pending', 'suspended');

-- CreateTable
CREATE TABLE "companies" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT,
    "registration_number" TEXT,
    "tax_identification_number" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "address" JSONB NOT NULL DEFAULT '{}',
    "logo_url" TEXT,
    "base_currency" TEXT NOT NULL DEFAULT 'RWF',
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1,
    "default_payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "industry" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "approval_status" "CompanyApprovalStatus" NOT NULL DEFAULT 'approved',
    "registration_rejection_reason" TEXT,
    "is_vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "vat_rate_pct" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "setup_completed" BOOLEAN NOT NULL DEFAULT false,
    "setup_steps_completed" JSONB NOT NULL DEFAULT '{}',
    "subscription_plan" "SubscriptionPlan" NOT NULL DEFAULT 'starter',
    "subscription_status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "billing_cycle" "BillingCycle" NOT NULL DEFAULT 'monthly',
    "billing_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "next_billing_date" TIMESTAMPTZ(3),
    "feature_access" JSONB NOT NULL DEFAULT '{}',
    "subscription_modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platform_notes" TEXT NOT NULL DEFAULT '',
    "last_payment_reminder_at" TIMESTAMPTZ(3),
    "last_platform_message_at" TIMESTAMPTZ(3),
    "trial_ends_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "refresh_token" TEXT,
    "refresh_token_hash" TEXT,
    "company_id" CHAR(24),
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "department_id" CHAR(24),
    "branch_id" CHAR(24),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login" TIMESTAMPTZ(3),
    "created_by" CHAR(24),
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMPTZ(3),
    "temp_password" BOOLEAN NOT NULL DEFAULT false,
    "avatar" TEXT,
    "phone" TEXT,
    "job_title" TEXT,
    "bio" TEXT,
    "two_fa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "two_fa_secret" TEXT,
    "two_fa_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "ip_whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "password_reset_token" TEXT,
    "password_reset_expires" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system_role" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" CHAR(24) NOT NULL,
    "role_id" CHAR(24) NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "company_users" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "status" "CompanyUserStatus" NOT NULL DEFAULT 'active',
    "approved_at" TIMESTAMPTZ(3),
    "approved_by" CHAR(24),
    "department_id" CHAR(24),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "last_active_at" TIMESTAMPTZ(3),
    "is_primary_contact" BOOLEAN NOT NULL DEFAULT false,
    "job_title" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "company_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" CHAR(24) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_code_key" ON "companies"("code");

-- CreateIndex
CREATE INDEX "companies_is_active_idx" ON "companies"("is_active");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_password_reset_token_idx" ON "users"("password_reset_token");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_email_key" ON "users"("company_id", "email");

-- CreateIndex
CREATE INDEX "roles_company_id_name_idx" ON "roles"("company_id", "name");

-- CreateIndex
CREATE INDEX "company_users_user_id_status_idx" ON "company_users"("user_id", "status");

-- CreateIndex
CREATE INDEX "company_users_company_id_status_idx" ON "company_users"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_users_user_id_company_id_key" ON "company_users"("user_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_is_revoked_idx" ON "refresh_tokens"("user_id", "is_revoked");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_is_active_idx" ON "user_sessions"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "user_sessions_last_active_at_idx" ON "user_sessions"("last_active_at");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_users" ADD CONSTRAINT "company_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_users" ADD CONSTRAINT "company_users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

