-- CreateTable
CREATE TABLE "asset_categories" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_useful_life_months" INTEGER NOT NULL,
    "default_depreciation_method" TEXT NOT NULL DEFAULT 'straight_line',
    "default_declining_rate" DECIMAL(19,4),
    "default_asset_account_code" TEXT NOT NULL DEFAULT '1700',
    "default_accum_depreciation_account_code" TEXT DEFAULT '1810',
    "default_depreciation_expense_account_code" TEXT DEFAULT '5800',
    "rra_asset_class" TEXT,
    "rra_useful_life_years" INTEGER,
    "rra_depreciation_method" TEXT,
    "rra_declining_rate" DECIMAL(19,4),
    "parent_category_id" CHAR(24),
    "category_code" TEXT,
    "is_componentizable" BOOLEAN NOT NULL DEFAULT false,
    "is_depreciable" BOOLEAN NOT NULL DEFAULT true,
    "default_depreciation_frequency" TEXT NOT NULL DEFAULT 'monthly',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" CHAR(24),
    "asset_account_id" CHAR(24),
    "asset_account_code" TEXT NOT NULL,
    "accum_depreciation_account_id" CHAR(24),
    "accum_depreciation_account_code" TEXT NOT NULL,
    "depreciation_expense_account_id" CHAR(24),
    "depreciation_expense_account_code" TEXT NOT NULL,
    "purchase_date" TIMESTAMPTZ(3) NOT NULL,
    "purchase_cost" DECIMAL(19,2) NOT NULL,
    "salvage_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "useful_life_months" INTEGER NOT NULL,
    "depreciation_method" TEXT NOT NULL DEFAULT 'straight_line',
    "declining_rate" DECIMAL(19,4),
    "status" TEXT NOT NULL DEFAULT 'in_transit',
    "in_service_date" TIMESTAMPTZ(3),
    "rra_in_service_date" TIMESTAMPTZ(3),
    "is_ready_for_service" BOOLEAN NOT NULL DEFAULT false,
    "disposal_date" TIMESTAMPTZ(3),
    "disposal_proceeds" DECIMAL(19,2),
    "disposal_costs" DECIMAL(19,2),
    "disposal_net_proceeds" DECIMAL(19,2),
    "disposal_gain_loss" DECIMAL(19,2),
    "disposal_method" TEXT,
    "disposal_notes" TEXT,
    "disposal_auth_number" TEXT,
    "disposal_customer_id" CHAR(24),
    "disposal_event_id" CHAR(24),
    "disposal_journal_entry_id" CHAR(24),
    "accumulated_depreciation" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "net_book_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "supplier_id" CHAR(24),
    "serial_number" TEXT,
    "location" TEXT,
    "department_id" CHAR(24),
    "warranty_start_date" TIMESTAMPTZ(3),
    "warranty_end_date" TIMESTAMPTZ(3),
    "insured_value" DECIMAL(19,2),
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "depreciation_frequency" TEXT NOT NULL DEFAULT 'monthly',
    "last_depreciation_period" TEXT,
    "last_depreciation_date" TIMESTAMPTZ(3),
    "acquisition_method" TEXT NOT NULL DEFAULT 'purchase',
    "donation_fair_value" DECIMAL(19,2),
    "construction_completion_date" TIMESTAMPTZ(3),
    "custodian_id" CHAR(24),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_entries" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "asset_id" CHAR(24) NOT NULL,
    "period_date" TIMESTAMPTZ(3) NOT NULL,
    "depreciation_amount" DECIMAL(19,2) NOT NULL,
    "accumulated_before" DECIMAL(19,2) NOT NULL,
    "accumulated_after" DECIMAL(19,2) NOT NULL,
    "net_book_value_after" DECIMAL(19,2) NOT NULL,
    "journal_entry_id" CHAR(24) NOT NULL,
    "posted_by" CHAR(24) NOT NULL,
    "is_reversed" BOOLEAN NOT NULL DEFAULT false,
    "reversed_by" CHAR(24),
    "reversed_at" TIMESTAMPTZ(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "depreciation_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_disposal_events" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "asset_id" CHAR(24) NOT NULL,
    "disposal_date" TIMESTAMPTZ(3) NOT NULL,
    "disposal_method" TEXT NOT NULL,
    "gross_proceeds" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "disposal_costs" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "net_proceeds" DECIMAL(19,2) NOT NULL,
    "original_cost" DECIMAL(19,2) NOT NULL,
    "accumulated_depreciation" DECIMAL(19,2) NOT NULL,
    "net_book_value" DECIMAL(19,2) NOT NULL,
    "gain_loss" DECIMAL(19,2) NOT NULL,
    "gain_loss_type" TEXT NOT NULL,
    "disposal_journal_entry_id" CHAR(24),
    "trade_in_asset_id" CHAR(24),
    "trade_in_value" DECIMAL(19,2),
    "sold_to_customer_id" CHAR(24),
    "sale_invoice_id" CHAR(24),
    "proceeds_bank_account_id" CHAR(24),
    "disposal_auth_number" TEXT,
    "rra_notified" BOOLEAN NOT NULL DEFAULT false,
    "rra_notification_date" TIMESTAMPTZ(3),
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "processed_by" CHAR(24) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "is_reversed" BOOLEAN NOT NULL DEFAULT false,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by" CHAR(24),
    "reversal_reason" TEXT,

    CONSTRAINT "asset_disposal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_status_histories" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "asset_id" CHAR(24) NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" CHAR(24) NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "supporting_document_url" TEXT,
    "location_at_change" TEXT,
    "department_id_at_change" CHAR(24),
    "custodian_id_at_change" CHAR(24),
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "asset_status_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "employee_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "date_of_birth" TIMESTAMPTZ(3),
    "gender" TEXT,
    "national_id" TEXT,
    "hire_date" TIMESTAMPTZ(3),
    "termination_date" TIMESTAMPTZ(3),
    "employment_type" TEXT NOT NULL DEFAULT 'full-time',
    "department" TEXT,
    "department_ref_id" CHAR(24),
    "position" TEXT,
    "location" TEXT,
    "manager_id" CHAR(24),
    "labor_type" TEXT,
    "default_direct_percentage" DOUBLE PRECISION,
    "cost_center" TEXT,
    "bank_name" TEXT,
    "bank_account" TEXT,
    "bank_branch" TEXT,
    "mobile_money_number" TEXT,
    "tax_status" TEXT NOT NULL DEFAULT 'resident',
    "rssb_registration_number" TEXT,
    "tin_number" TEXT,
    "current_salary" JSONB,
    "created_by" CHAR(24),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_histories" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "employee_id" CHAR(24) NOT NULL,
    "basic_salary" DECIMAL(19,2) NOT NULL,
    "transport_allowance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "housing_allowance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "other_allowances" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "effective_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "reason" TEXT,
    "changed_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "salary_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "employee_id" CHAR(24),
    "employee" JSONB NOT NULL,
    "salary" JSONB NOT NULL,
    "deductions" JSONB NOT NULL DEFAULT '{}',
    "net_pay" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "labor_allocation" JSONB NOT NULL DEFAULT '{}',
    "contributions" JSONB NOT NULL DEFAULT '{}',
    "period" JSONB NOT NULL,
    "payroll_run_id" CHAR(24),
    "pay_period_start" TIMESTAMPTZ(3),
    "pay_period_end" TIMESTAMPTZ(3),
    "record_status" TEXT NOT NULL DEFAULT 'draft',
    "payment" JSONB NOT NULL DEFAULT '{}',
    "payslip_generated" BOOLEAN NOT NULL DEFAULT false,
    "payslip_date" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_by" CHAR(24),
    "approved_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "pay_period_start" TIMESTAMPTZ(3) NOT NULL,
    "pay_period_end" TIMESTAMPTZ(3) NOT NULL,
    "payment_date" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total_gross" DECIMAL(19,2) NOT NULL,
    "total_tax" DECIMAL(19,2) NOT NULL,
    "total_other_deductions" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(19,2) NOT NULL,
    "bank_account_id" CHAR(24) NOT NULL,
    "salary_account_id" CHAR(24) NOT NULL,
    "tax_payable_account_id" CHAR(24) NOT NULL,
    "other_deductions_account_id" CHAR(24),
    "journal_entry_id" CHAR(24),
    "reversal_journal_entry_id" CHAR(24),
    "net_pay_journal_id" CHAR(24),
    "paye_remit_journal_id" CHAR(24),
    "rssb_remit_journal_id" CHAR(24),
    "notes" TEXT,
    "posted_by" CHAR(24),
    "lines" JSONB NOT NULL DEFAULT '[]',
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "remittance" JSONB NOT NULL DEFAULT '{}',
    "bank_transfer" JSONB NOT NULL DEFAULT '{}',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheets" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "employee_id" CHAR(24) NOT NULL,
    "employee_name" TEXT NOT NULL,
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month_name" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "total_hours" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "direct_hours" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "indirect_hours" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "direct_percentage" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "indirect_percentage" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "created_by" CHAR(24),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_advances" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "employee_id" CHAR(24) NOT NULL,
    "reference_no" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(19,2) NOT NULL,
    "amount_repaid" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "issue_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'issued',
    "payment_method" TEXT NOT NULL DEFAULT 'cash',
    "bank_account_id" CHAR(24),
    "journal_entry_id" CHAR(24),
    "repayments" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "purpose" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT,
    "type" TEXT NOT NULL DEFAULT 'expense',
    "budget_cycle" TEXT NOT NULL DEFAULT 'fixed_year',
    "fiscal_year" INTEGER NOT NULL,
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "period_type" TEXT NOT NULL DEFAULT 'yearly',
    "amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "department_id" CHAR(24),
    "owner_id" CHAR(24),
    "entity_id" CHAR(24),
    "base_currency" TEXT,
    "exchange_rate_type" TEXT NOT NULL DEFAULT 'spot',
    "exchange_rate" DECIMAL(19,6) NOT NULL DEFAULT 1,
    "allow_multi_currency" BOOLEAN NOT NULL DEFAULT false,
    "allocation_method" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "workflow_id" CHAR(24),
    "current_approval_step" INTEGER NOT NULL DEFAULT 0,
    "total_approval_steps" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(24) NOT NULL,
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "locked_by" CHAR(24),
    "locked_at" TIMESTAMPTZ(3),
    "unlocked_by" CHAR(24),
    "unlocked_at" TIMESTAMPTZ(3),
    "rejected_by" CHAR(24),
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT NOT NULL DEFAULT '',
    "closed_by" CHAR(24),
    "closed_at" TIMESTAMPTZ(3),
    "close_notes" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "auto_lock" JSONB NOT NULL DEFAULT '{}',
    "fiscal_year_end" TIMESTAMPTZ(3),
    "year_end_lock" BOOLEAN NOT NULL DEFAULT false,
    "auto_locked" BOOLEAN NOT NULL DEFAULT false,
    "scenario_type" TEXT NOT NULL DEFAULT 'base',
    "scenario_name" TEXT,
    "scenario_group_id" TEXT,
    "is_primary_scenario" BOOLEAN NOT NULL DEFAULT true,
    "parent_budget_id" CHAR(24),
    "scenario_description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "account_id" CHAR(24) NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "budgeted_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "encumbered_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "actual_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "project_id" CHAR(24),
    "wbs_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_workflow_configs" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "workflow_type" TEXT NOT NULL,
    "min_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "max_amount" DECIMAL(19,2),
    "department_scope" TEXT NOT NULL DEFAULT 'all',
    "department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "steps" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(3),
    "created_by" CHAR(24) NOT NULL,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_workflow_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_actual_consumptions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "budget_line_id" CHAR(24) NOT NULL,
    "account_id" CHAR(24) NOT NULL,
    "project_id" CHAR(24),
    "wbs_code" TEXT,
    "origin_type" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "document_number" TEXT NOT NULL DEFAULT '',
    "document_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "source_type" TEXT NOT NULL DEFAULT '',
    "source_id" TEXT NOT NULL DEFAULT '',
    "source_number" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_actual_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_transfers" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "from_line_id" CHAR(24) NOT NULL,
    "from_account_id" CHAR(24) NOT NULL,
    "from_account_code" TEXT NOT NULL,
    "from_account_name" TEXT NOT NULL,
    "to_line_id" CHAR(24) NOT NULL,
    "to_account_id" CHAR(24) NOT NULL,
    "to_account_code" TEXT NOT NULL,
    "to_account_name" TEXT NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "transfer_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" CHAR(24) NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" CHAR(24),
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by" CHAR(24),
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT NOT NULL DEFAULT '',
    "executed_by" CHAR(24),
    "executed_at" TIMESTAMPTZ(3),
    "cancelled_by" CHAR(24),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT NOT NULL DEFAULT '',
    "original_from_budgeted" DECIMAL(19,2),
    "original_to_budgeted" DECIMAL(19,2),
    "new_from_budgeted" DECIMAL(19,2),
    "new_to_budgeted" DECIMAL(19,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_revisions" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "change_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "field_changes" JSONB NOT NULL DEFAULT '[]',
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "affected_line_id" CHAR(24),
    "amount_impact" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "changed_by" CHAR(24) NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "rolled_back" BOOLEAN NOT NULL DEFAULT false,
    "rolled_back_by" CHAR(24),
    "rolled_back_at" TIMESTAMPTZ(3),
    "rollback_reason" TEXT,
    "related_document_type" TEXT,
    "related_document_id" CHAR(24),
    "comments" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_period_locks" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "locked_periods" JSONB NOT NULL DEFAULT '[]',
    "auto_lock" JSONB NOT NULL DEFAULT '{}',
    "fiscal_year_end" JSONB NOT NULL DEFAULT '{}',
    "year_end_lock" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_period_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_approvals" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "workflow_type" TEXT NOT NULL,
    "workflow_id" CHAR(24),
    "related_document_type" TEXT,
    "related_document_id" CHAR(24),
    "amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "workflow_name" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "current_step" INTEGER NOT NULL DEFAULT 1,
    "total_steps" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "requested_by" CHAR(24) NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_comments" TEXT NOT NULL DEFAULT '',
    "final_approved_by" CHAR(24),
    "final_approved_at" TIMESTAMPTZ(3),
    "rejected_by" CHAR(24),
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT NOT NULL DEFAULT '',
    "changes_requested_by" CHAR(24),
    "changes_requested_at" TIMESTAMPTZ(3),
    "changes_required" TEXT NOT NULL DEFAULT '',
    "cancelled_by" CHAR(24),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "due_date" TIMESTAMPTZ(3),
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_alerts" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24),
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "thresholds" JSONB NOT NULL DEFAULT '{"warning":75,"critical":90,"exceeded":100}',
    "variance_tolerance" DECIMAL(19,4) NOT NULL DEFAULT 5,
    "alert_frequency" TEXT NOT NULL DEFAULT 'weekly',
    "last_alert_sent" TIMESTAMPTZ(3),
    "notify_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notify_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels" JSONB NOT NULL DEFAULT '{"in_app":true,"email":true,"sms":false}',
    "alert_types" JSONB NOT NULL DEFAULT '{}',
    "account_overrides" JSONB NOT NULL DEFAULT '[]',
    "quiet_hours" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encumbrances" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "budget_id" CHAR(24) NOT NULL,
    "budget_line_id" CHAR(24) NOT NULL,
    "account_id" CHAR(24) NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_number" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "encumbered_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "liquidated_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "released_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "remaining_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "encumbrance_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_liquidation_date" TIMESTAMPTZ(3),
    "liquidated_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "liquidations" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "released_by" CHAR(24),
    "release_reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "encumbrances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "project_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "parent_id" CHAR(24),
    "wbs_level" INTEGER NOT NULL DEFAULT 1,
    "wbs_code" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'project',
    "status" TEXT NOT NULL DEFAULT 'planning',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "budget_allocated" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "budget_spent" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "budget_remaining" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "start_date" TIMESTAMPTZ(3),
    "end_date" TIMESTAMPTZ(3),
    "actual_start_date" TIMESTAMPTZ(3),
    "actual_end_date" TIMESTAMPTZ(3),
    "department_id" CHAR(24),
    "client_id" CHAR(24),
    "manager_id" CHAR(24),
    "billing_type" TEXT NOT NULL DEFAULT 'none',
    "contract_value" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "progress_percent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_devices" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "tin" TEXT NOT NULL,
    "branch_id" VARCHAR(2) NOT NULL,
    "branch_name" TEXT,
    "branch_ref_id" CHAR(24),
    "device_serial_no" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_initialized',
    "initialized_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error_message" TEXT,
    "initialized_mode" TEXT,
    "last_attempt_mode" TEXT,
    "init_result" JSONB,
    "created_by" CHAR(24),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_codes" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "code_class" TEXT NOT NULL,
    "code_class_name" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_item_classes" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "item_class_code" TEXT NOT NULL,
    "item_class_name" TEXT NOT NULL,
    "item_class_level" INTEGER,
    "parent_code" TEXT,
    "tax_type_code" TEXT,
    "major_target" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_item_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_tins" (
    "id" CHAR(24) NOT NULL,
    "tin" TEXT NOT NULL,
    "taxpayer_name" TEXT NOT NULL,
    "status_code" TEXT,
    "province_name" TEXT,
    "district_name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_tins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_notices" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "notice_number" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT,
    "notice_date" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_imported_items" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "branch_id" VARCHAR(2) NOT NULL DEFAULT '00',
    "import_task_code" TEXT NOT NULL,
    "import_declaration_no" TEXT,
    "import_date" TIMESTAMPTZ(3),
    "item_code" TEXT,
    "item_name" TEXT NOT NULL,
    "item_class_code" TEXT,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unit_code" TEXT,
    "origin_country_code" TEXT,
    "supplier_tin" TEXT,
    "supplier_name" TEXT,
    "unit_cost" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_type_code" TEXT,
    "tax_rate" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "confirmation_status" TEXT NOT NULL DEFAULT 'pending',
    "pulled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by" CHAR(24),
    "rejected_at" TIMESTAMPTZ(3),
    "rejected_by" CHAR(24),
    "rejection_reason" TEXT,
    "stock_updated" BOOLEAN NOT NULL DEFAULT false,
    "stock_update_error" TEXT,
    "confirmation_error" TEXT,
    "product_id" CHAR(24),
    "warehouse_id" CHAR(24),
    "supplier_id" CHAR(24),
    "purchase_order_id" CHAR(24),
    "grn_id" CHAR(24),
    "rra_confirmed_at" TIMESTAMPTZ(3),
    "rra_result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_imported_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_unmatched_purchases" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "branch_id" VARCHAR(2) NOT NULL,
    "supplier_tin" TEXT,
    "supplier_name" TEXT,
    "seller_invoice_no" TEXT NOT NULL,
    "invoice_date" TIMESTAMPTZ(3),
    "total_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "linked_document_type" TEXT,
    "linked_document_id" CHAR(24),
    "reviewed_by" CHAR(24),
    "reviewed_at" TIMESTAMPTZ(3),
    "pulled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_unmatched_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_submission_queues" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_id" CHAR(24) NOT NULL,
    "endpoint" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL DEFAULT 'default',
    "payload" JSONB NOT NULL,
    "ebm_status" TEXT NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 5,
    "next_retry_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error" JSONB NOT NULL DEFAULT '{}',
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "is_retryable" BOOLEAN NOT NULL DEFAULT true,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_submission_queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_alerts" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "queue_id" CHAR(24) NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_id" CHAR(24) NOT NULL,
    "endpoint" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL DEFAULT 'default',
    "attempts_made" INTEGER NOT NULL,
    "last_error_message" TEXT,
    "last_error_code" TEXT,
    "last_http_status" INTEGER,
    "payload" JSONB,
    "abandoned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by" CHAR(24),
    "reset_at" TIMESTAMPTZ(3),
    "reset_by" CHAR(24),
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_sync_states" (
    "id" CHAR(24) NOT NULL,
    "company_id" CHAR(24) NOT NULL,
    "branch_id" VARCHAR(2) NOT NULL,
    "sync_type" TEXT NOT NULL,
    "last_req_dt" TEXT NOT NULL DEFAULT '20000101000000',
    "last_successful_sync_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error_message" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'mock',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ebm_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_categories_company_id_is_system_idx" ON "asset_categories"("company_id", "is_system");

-- CreateIndex
CREATE UNIQUE INDEX "asset_categories_company_id_name_key" ON "asset_categories"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_disposal_event_id_key" ON "fixed_assets"("disposal_event_id");

-- CreateIndex
CREATE INDEX "fixed_assets_company_id_status_idx" ON "fixed_assets"("company_id", "status");

-- CreateIndex
CREATE INDEX "fixed_assets_company_id_category_id_idx" ON "fixed_assets"("company_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_company_id_reference_no_key" ON "fixed_assets"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "depreciation_entries_company_id_period_date_idx" ON "depreciation_entries"("company_id", "period_date");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_entries_company_id_asset_id_period_date_key" ON "depreciation_entries"("company_id", "asset_id", "period_date");

-- CreateIndex
CREATE INDEX "asset_disposal_events_company_id_asset_id_idx" ON "asset_disposal_events"("company_id", "asset_id");

-- CreateIndex
CREATE INDEX "asset_disposal_events_company_id_disposal_date_idx" ON "asset_disposal_events"("company_id", "disposal_date" DESC);

-- CreateIndex
CREATE INDEX "asset_disposal_events_company_id_disposal_method_idx" ON "asset_disposal_events"("company_id", "disposal_method");

-- CreateIndex
CREATE INDEX "asset_disposal_events_company_id_gain_loss_type_idx" ON "asset_disposal_events"("company_id", "gain_loss_type");

-- CreateIndex
CREATE INDEX "asset_status_histories_company_id_asset_id_changed_at_idx" ON "asset_status_histories"("company_id", "asset_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "asset_status_histories_company_id_from_status_to_status_idx" ON "asset_status_histories"("company_id", "from_status", "to_status");

-- CreateIndex
CREATE INDEX "asset_status_histories_asset_id_to_status_idx" ON "asset_status_histories"("asset_id", "to_status");

-- CreateIndex
CREATE INDEX "asset_status_histories_changed_at_idx" ON "asset_status_histories"("changed_at" DESC);

-- CreateIndex
CREATE INDEX "employees_company_id_status_idx" ON "employees"("company_id", "status");

-- CreateIndex
CREATE INDEX "employees_company_id_department_idx" ON "employees"("company_id", "department");

-- CreateIndex
CREATE INDEX "employees_company_id_employment_type_idx" ON "employees"("company_id", "employment_type");

-- CreateIndex
CREATE UNIQUE INDEX "employees_company_id_employee_id_key" ON "employees"("company_id", "employee_id");

-- CreateIndex
CREATE INDEX "salary_histories_company_id_employee_id_effective_date_idx" ON "salary_histories"("company_id", "employee_id", "effective_date" DESC);

-- CreateIndex
CREATE INDEX "salary_histories_company_id_employee_id_end_date_idx" ON "salary_histories"("company_id", "employee_id", "end_date");

-- CreateIndex
CREATE INDEX "payrolls_company_id_payroll_run_id_idx" ON "payrolls"("company_id", "payroll_run_id");

-- CreateIndex
CREATE INDEX "payrolls_company_id_employee_id_idx" ON "payrolls"("company_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_payment_date_idx" ON "payroll_runs"("company_id", "payment_date" DESC);

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_status_idx" ON "payroll_runs"("company_id", "status");

-- CreateIndex
CREATE INDEX "payroll_runs_company_id_pay_period_start_pay_period_end_idx" ON "payroll_runs"("company_id", "pay_period_start", "pay_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_company_id_reference_no_key" ON "payroll_runs"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "timesheets_company_id_status_idx" ON "timesheets"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheets_company_id_employee_id_period_month_period_year_key" ON "timesheets"("company_id", "employee_id", "period_month", "period_year");

-- CreateIndex
CREATE INDEX "employee_advances_company_id_employee_id_status_idx" ON "employee_advances"("company_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "employee_advances_company_id_status_issue_date_idx" ON "employee_advances"("company_id", "status", "issue_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "employee_advances_company_id_reference_no_key" ON "employee_advances"("company_id", "reference_no");

-- CreateIndex
CREATE INDEX "budgets_company_id_status_idx" ON "budgets"("company_id", "status");

-- CreateIndex
CREATE INDEX "budgets_company_id_type_idx" ON "budgets"("company_id", "type");

-- CreateIndex
CREATE INDEX "budgets_company_id_department_id_idx" ON "budgets"("company_id", "department_id");

-- CreateIndex
CREATE INDEX "budgets_company_id_owner_id_idx" ON "budgets"("company_id", "owner_id");

-- CreateIndex
CREATE INDEX "budgets_company_id_entity_id_idx" ON "budgets"("company_id", "entity_id");

-- CreateIndex
CREATE INDEX "budgets_company_id_category_idx" ON "budgets"("company_id", "category");

-- CreateIndex
CREATE INDEX "budgets_company_id_period_start_period_end_idx" ON "budgets"("company_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "budgets_company_id_scenario_group_id_idx" ON "budgets"("company_id", "scenario_group_id");

-- CreateIndex
CREATE INDEX "budgets_company_id_parent_budget_id_idx" ON "budgets"("company_id", "parent_budget_id");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_company_id_fiscal_year_name_scenario_type_key" ON "budgets"("company_id", "fiscal_year", "name", "scenario_type");

-- CreateIndex
CREATE INDEX "budget_lines_company_id_budget_id_period_year_period_month_idx" ON "budget_lines"("company_id", "budget_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "budget_lines_company_id_account_id_period_year_period_month_idx" ON "budget_lines"("company_id", "account_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "budget_lines_company_id_project_id_period_year_period_month_idx" ON "budget_lines"("company_id", "project_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "budget_workflow_configs_company_id_workflow_type_is_active_idx" ON "budget_workflow_configs"("company_id", "workflow_type", "is_active");

-- CreateIndex
CREATE INDEX "budget_workflow_configs_company_id_is_default_workflow_type_idx" ON "budget_workflow_configs"("company_id", "is_default", "workflow_type");

-- CreateIndex
CREATE INDEX "budget_workflow_configs_company_id_priority_idx" ON "budget_workflow_configs"("company_id", "priority" DESC);

-- CreateIndex
CREATE INDEX "budget_actual_consumptions_company_id_budget_id_budget_line_idx" ON "budget_actual_consumptions"("company_id", "budget_id", "budget_line_id", "document_date" DESC);

-- CreateIndex
CREATE INDEX "budget_actual_consumptions_company_id_origin_type_idx" ON "budget_actual_consumptions"("company_id", "origin_type");

-- CreateIndex
CREATE INDEX "budget_transfers_company_id_budget_id_status_idx" ON "budget_transfers"("company_id", "budget_id", "status");

-- CreateIndex
CREATE INDEX "budget_transfers_company_id_status_requested_at_idx" ON "budget_transfers"("company_id", "status", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "budget_transfers_from_line_id_idx" ON "budget_transfers"("from_line_id");

-- CreateIndex
CREATE INDEX "budget_transfers_to_line_id_idx" ON "budget_transfers"("to_line_id");

-- CreateIndex
CREATE INDEX "budget_revisions_company_id_budget_id_changed_at_idx" ON "budget_revisions"("company_id", "budget_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "budget_revisions_company_id_changed_by_idx" ON "budget_revisions"("company_id", "changed_by");

-- CreateIndex
CREATE INDEX "budget_revisions_change_type_idx" ON "budget_revisions"("change_type");

-- CreateIndex
CREATE UNIQUE INDEX "budget_revisions_company_id_budget_id_revision_number_key" ON "budget_revisions"("company_id", "budget_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "budget_period_locks_budget_id_key" ON "budget_period_locks"("budget_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_period_locks_company_id_budget_id_key" ON "budget_period_locks"("company_id", "budget_id");

-- CreateIndex
CREATE INDEX "budget_approvals_company_id_budget_id_status_idx" ON "budget_approvals"("company_id", "budget_id", "status");

-- CreateIndex
CREATE INDEX "budget_approvals_company_id_status_priority_requested_at_idx" ON "budget_approvals"("company_id", "status", "priority", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "budget_approvals_company_id_workflow_type_status_idx" ON "budget_approvals"("company_id", "workflow_type", "status");

-- CreateIndex
CREATE INDEX "budget_approvals_workflow_id_status_idx" ON "budget_approvals"("workflow_id", "status");

-- CreateIndex
CREATE INDEX "budget_approvals_requested_by_status_idx" ON "budget_approvals"("requested_by", "status");

-- CreateIndex
CREATE INDEX "budget_approvals_related_document_type_related_document_id_idx" ON "budget_approvals"("related_document_type", "related_document_id");

-- CreateIndex
CREATE INDEX "budget_alerts_company_id_is_enabled_idx" ON "budget_alerts"("company_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "budget_alerts_company_id_budget_id_key" ON "budget_alerts"("company_id", "budget_id");

-- CreateIndex
CREATE INDEX "encumbrances_company_id_budget_id_status_idx" ON "encumbrances"("company_id", "budget_id", "status");

-- CreateIndex
CREATE INDEX "encumbrances_company_id_account_id_status_idx" ON "encumbrances"("company_id", "account_id", "status");

-- CreateIndex
CREATE INDEX "encumbrances_budget_line_id_status_idx" ON "encumbrances"("budget_line_id", "status");

-- CreateIndex
CREATE INDEX "encumbrances_source_type_source_id_idx" ON "encumbrances"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "encumbrances_encumbrance_date_idx" ON "encumbrances"("encumbrance_date" DESC);

-- CreateIndex
CREATE INDEX "projects_company_id_status_idx" ON "projects"("company_id", "status");

-- CreateIndex
CREATE INDEX "projects_company_id_type_idx" ON "projects"("company_id", "type");

-- CreateIndex
CREATE INDEX "projects_company_id_parent_id_idx" ON "projects"("company_id", "parent_id");

-- CreateIndex
CREATE INDEX "projects_company_id_wbs_code_idx" ON "projects"("company_id", "wbs_code");

-- CreateIndex
CREATE INDEX "projects_company_id_department_id_idx" ON "projects"("company_id", "department_id");

-- CreateIndex
CREATE INDEX "projects_company_id_client_id_idx" ON "projects"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "projects_company_id_is_active_idx" ON "projects"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "projects_company_id_project_code_key" ON "projects"("company_id", "project_code");

-- CreateIndex
CREATE INDEX "ebm_devices_company_id_branch_id_idx" ON "ebm_devices"("company_id", "branch_id");

-- CreateIndex
CREATE INDEX "ebm_devices_company_id_status_idx" ON "ebm_devices"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_devices_company_id_branch_id_device_serial_no_key" ON "ebm_devices"("company_id", "branch_id", "device_serial_no");

-- CreateIndex
CREATE INDEX "ebm_codes_company_id_code_class_active_idx" ON "ebm_codes"("company_id", "code_class", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_codes_company_id_code_class_code_key" ON "ebm_codes"("company_id", "code_class", "code");

-- CreateIndex
CREATE INDEX "ebm_item_classes_company_id_item_class_name_idx" ON "ebm_item_classes"("company_id", "item_class_name");

-- CreateIndex
CREATE INDEX "ebm_item_classes_company_id_parent_code_idx" ON "ebm_item_classes"("company_id", "parent_code");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_item_classes_company_id_item_class_code_key" ON "ebm_item_classes"("company_id", "item_class_code");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_tins_tin_key" ON "ebm_tins"("tin");

-- CreateIndex
CREATE INDEX "ebm_tins_tin_taxpayer_name_idx" ON "ebm_tins"("tin", "taxpayer_name");

-- CreateIndex
CREATE INDEX "ebm_tins_active_idx" ON "ebm_tins"("active");

-- CreateIndex
CREATE INDEX "ebm_notices_company_id_notice_date_idx" ON "ebm_notices"("company_id", "notice_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ebm_notices_company_id_notice_number_key" ON "ebm_notices"("company_id", "notice_number");

-- CreateIndex
CREATE INDEX "ebm_imported_items_company_id_confirmation_status_import_da_idx" ON "ebm_imported_items"("company_id", "confirmation_status", "import_date" DESC);

-- CreateIndex
CREATE INDEX "ebm_imported_items_company_id_item_code_idx" ON "ebm_imported_items"("company_id", "item_code");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_imported_items_company_id_branch_id_import_task_code_key" ON "ebm_imported_items"("company_id", "branch_id", "import_task_code");

-- CreateIndex
CREATE INDEX "ebm_unmatched_purchases_company_id_branch_id_idx" ON "ebm_unmatched_purchases"("company_id", "branch_id");

-- CreateIndex
CREATE INDEX "ebm_unmatched_purchases_company_id_status_pulled_at_idx" ON "ebm_unmatched_purchases"("company_id", "status", "pulled_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ebm_unmatched_purchases_company_id_branch_id_supplier_tin_s_key" ON "ebm_unmatched_purchases"("company_id", "branch_id", "supplier_tin", "seller_invoice_no");

-- CreateIndex
CREATE INDEX "ebm_submission_queues_company_id_document_type_idx" ON "ebm_submission_queues"("company_id", "document_type");

-- CreateIndex
CREATE INDEX "ebm_submission_queues_company_id_document_id_idx" ON "ebm_submission_queues"("company_id", "document_id");

-- CreateIndex
CREATE INDEX "ebm_submission_queues_ebm_status_is_retryable_next_retry_at_idx" ON "ebm_submission_queues"("ebm_status", "is_retryable", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_submission_queues_company_id_document_type_document_id__key" ON "ebm_submission_queues"("company_id", "document_type", "document_id", "endpoint", "operation_key");

-- CreateIndex
CREATE INDEX "ebm_alerts_company_id_acknowledged_abandoned_at_idx" ON "ebm_alerts"("company_id", "acknowledged", "abandoned_at" DESC);

-- CreateIndex
CREATE INDEX "ebm_alerts_queue_id_status_idx" ON "ebm_alerts"("queue_id", "status");

-- CreateIndex
CREATE INDEX "ebm_alerts_company_id_document_type_idx" ON "ebm_alerts"("company_id", "document_type");

-- CreateIndex
CREATE INDEX "ebm_sync_states_company_id_sync_type_idx" ON "ebm_sync_states"("company_id", "sync_type");

-- CreateIndex
CREATE INDEX "ebm_sync_states_company_id_last_successful_sync_at_idx" ON "ebm_sync_states"("company_id", "last_successful_sync_at");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_sync_states_company_id_branch_id_sync_type_mode_key" ON "ebm_sync_states"("company_id", "branch_id", "sync_type", "mode");

-- AddForeignKey
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "asset_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "asset_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_event_id_fkey" FOREIGN KEY ("disposal_event_id") REFERENCES "asset_disposal_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_disposal_events" ADD CONSTRAINT "asset_disposal_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_disposal_events" ADD CONSTRAINT "asset_disposal_events_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_disposal_events" ADD CONSTRAINT "asset_disposal_events_trade_in_asset_id_fkey" FOREIGN KEY ("trade_in_asset_id") REFERENCES "fixed_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_status_histories" ADD CONSTRAINT "asset_status_histories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_status_histories" ADD CONSTRAINT "asset_status_histories_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_histories" ADD CONSTRAINT "salary_histories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_histories" ADD CONSTRAINT "salary_histories_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "budget_workflow_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_parent_budget_id_fkey" FOREIGN KEY ("parent_budget_id") REFERENCES "budgets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_workflow_configs" ADD CONSTRAINT "budget_workflow_configs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_actual_consumptions" ADD CONSTRAINT "budget_actual_consumptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_actual_consumptions" ADD CONSTRAINT "budget_actual_consumptions_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_actual_consumptions" ADD CONSTRAINT "budget_actual_consumptions_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "budget_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_actual_consumptions" ADD CONSTRAINT "budget_actual_consumptions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_from_line_id_fkey" FOREIGN KEY ("from_line_id") REFERENCES "budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_to_line_id_fkey" FOREIGN KEY ("to_line_id") REFERENCES "budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revisions" ADD CONSTRAINT "budget_revisions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_revisions" ADD CONSTRAINT "budget_revisions_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_period_locks" ADD CONSTRAINT "budget_period_locks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_period_locks" ADD CONSTRAINT "budget_period_locks_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_approvals" ADD CONSTRAINT "budget_approvals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_approvals" ADD CONSTRAINT "budget_approvals_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_approvals" ADD CONSTRAINT "budget_approvals_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "budget_workflow_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encumbrances" ADD CONSTRAINT "encumbrances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encumbrances" ADD CONSTRAINT "encumbrances_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encumbrances" ADD CONSTRAINT "encumbrances_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "budget_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_devices" ADD CONSTRAINT "ebm_devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_codes" ADD CONSTRAINT "ebm_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_item_classes" ADD CONSTRAINT "ebm_item_classes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_notices" ADD CONSTRAINT "ebm_notices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_imported_items" ADD CONSTRAINT "ebm_imported_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_unmatched_purchases" ADD CONSTRAINT "ebm_unmatched_purchases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_submission_queues" ADD CONSTRAINT "ebm_submission_queues_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_alerts" ADD CONSTRAINT "ebm_alerts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_alerts" ADD CONSTRAINT "ebm_alerts_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "ebm_submission_queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_sync_states" ADD CONSTRAINT "ebm_sync_states_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

