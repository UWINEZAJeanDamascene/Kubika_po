const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const DEFAULT_PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'Core operations for small businesses',
    features: ['inventory', 'sales', 'finance'],
    modules: [
      'Inventory Core|Products & Categories',
      'Inventory Core|Warehouses',
      'Inventory Core|Stock Levels',
      'Inventory Core|Stock Movements',
      'Revenue Flow|POS',
      'Revenue Flow|Quotations & Sales Orders',
      'Revenue Flow|Invoices',
      'Revenue Flow|Delivery Notes',
      'Finance Control|Bank Accounts',
      'Finance Control|Journal Entries',
      'Finance Control|Petty Cash',
      'Finance Control|Expenses'
    ],
    outcomes: ['included|control|Control Room included'],
    badge: 'Entry tier',
    icon: 'Boxes',
    featured: false,
    button_label: 'Learn more',
    default_billing_amount: 10000,
    default_billing_cycle: 'monthly',
    sort_order: 1
  },
  {
    key: 'professional',
    name: 'Growth',
    description: 'Full operations + supply chain',
    features: ['inventory', 'sales', 'purchases', 'finance', 'reports'],
    modules: [
      'Everything in Starter, plus|Inventory Core (Full)',
      'Inventory Core (Full)|Batches & Serial Numbers',
      'Revenue Flow (Full)|Clients',
      'Revenue Flow (Full)|Pick Packs',
      'Revenue Flow (Full)|Credit Notes',
      'Revenue Flow (Full)|Recurring Invoices',
      'Revenue Flow (Full)|Accounts Receivable & Payable',
      'Supply Chain|Suppliers',
      'Supply Chain|Purchase Orders',
      'Supply Chain|Goods Received',
      'Supply Chain|Purchase Returns & Purchases',
      'Finance Control|Chart of Accounts',
      'Finance Control|Liabilities & Fixed Assets',
      'Finance Control|Budgets & Budget Settings',
      'Intelligence|Reports Hub',
      'Intelligence|Profit & Loss',
      'Intelligence|Cash Flow'
    ],
    outcomes: ['included|control|Control Room included'],
    badge: 'Most popular',
    icon: 'BarChart3',
    featured: true,
    button_label: 'Get started',
    default_billing_amount: 15000,
    default_billing_cycle: 'monthly',
    sort_order: 2
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'Full suite + AI-powered intelligence',
    features: ['inventory', 'sales', 'purchases', 'finance', 'payroll', 'reports', 'projects', 'fixed_assets', 'ai_assistant', 'integrations'],
    modules: [
      'Everything in Growth, plus|Finance Control (Full)',
      'Finance Control (Full)|Employees & Departments',
      'Finance Control (Full)|Payroll & Payroll Runs',
      'Finance Control (Full)|Accounting Periods',
      'Finance Control (Full)|Projects',
      'Intelligence|Balance Sheet',
      'Intelligence|Financial Ratios',
      'Intelligence|Debt Maturity'
    ],
    outcomes: [
      'included|ai|Stacy AI Assistant included',
      'included|control|Control Room included'
    ],
    badge: 'Full access',
    icon: 'ShieldCheck',
    featured: false,
    button_label: 'Learn more',
    default_billing_amount: 30000,
    default_billing_cycle: 'monthly',
    sort_order: 3
  }
];

function planToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    key: row.key,
    name: row.name,
    description: row.description || '',
    features: row.features || [],
    modules: row.modules || [],
    outcomes: row.outcomes || [],
    badge: row.badge || '',
    icon: row.icon || '',
    featured: Boolean(row.featured),
    button_label: row.buttonLabel || '',
    default_billing_amount: Number(row.defaultBillingAmount),
    default_billing_cycle: row.defaultBillingCycle,
    is_active: Boolean(row.isActive),
    sort_order: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizePlanInput(data) {
  const key = (data.key || '').toString().trim().toLowerCase();
  return {
    ...(key ? { key } : {}),
    ...(data.name !== undefined ? { name: String(data.name).trim() } : {}),
    ...(data.description !== undefined ? { description: String(data.description).trim() } : {}),
    ...(data.features !== undefined ? { features: Array.isArray(data.features) ? data.features : [] } : {}),
    ...(data.modules !== undefined ? { modules: Array.isArray(data.modules) ? data.modules : [] } : {}),
    ...(data.outcomes !== undefined ? { outcomes: Array.isArray(data.outcomes) ? data.outcomes : [] } : {}),
    ...(data.badge !== undefined ? { badge: String(data.badge).trim() } : {}),
    ...(data.icon !== undefined ? { icon: String(data.icon).trim() } : {}),
    ...(data.featured !== undefined ? { featured: Boolean(data.featured) } : {}),
    ...(data.button_label !== undefined || data.buttonLabel !== undefined
      ? { buttonLabel: String(data.button_label ?? data.buttonLabel ?? '').trim() }
      : {}),
    ...(data.default_billing_amount !== undefined || data.defaultBillingAmount !== undefined
      ? { defaultBillingAmount: Math.max(0, Number(data.default_billing_amount ?? data.defaultBillingAmount) || 0) }
      : {}),
    ...(data.default_billing_cycle !== undefined || data.defaultBillingCycle !== undefined
      ? { defaultBillingCycle: data.default_billing_cycle ?? data.defaultBillingCycle ?? 'monthly' }
      : {}),
    ...(data.is_active !== undefined || data.isActive !== undefined
      ? { isActive: data.is_active ?? data.isActive ?? true }
      : {}),
    ...(data.sort_order !== undefined || data.sortOrder !== undefined
      ? { sortOrder: Number(data.sort_order ?? data.sortOrder) || 0 }
      : {})
  };
}

function toCreateData(data) {
  const normalized = normalizePlanInput(data);
  return {
    id: generateObjectId(),
    key: normalized.key,
    name: normalized.name,
    description: normalized.description ?? '',
    features: normalized.features ?? [],
    modules: normalized.modules ?? [],
    outcomes: normalized.outcomes ?? [],
    badge: normalized.badge ?? '',
    icon: normalized.icon ?? '',
    featured: normalized.featured ?? false,
    buttonLabel: normalized.buttonLabel ?? '',
    defaultBillingAmount: normalized.defaultBillingAmount ?? 0,
    defaultBillingCycle: normalized.defaultBillingCycle ?? 'monthly',
    isActive: normalized.isActive ?? true,
    sortOrder: normalized.sortOrder ?? 0
  };
}

class SubscriptionPlanService {
  static async getAllPlans(activeOnly = false) {
    const rows = await prisma.subscriptionPlanCatalog.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    return rows.map(planToApi);
  }

  static async getPlanByKey(key) {
    const row = await prisma.subscriptionPlanCatalog.findUnique({
      where: { key: String(key).toLowerCase() }
    });
    return planToApi(row);
  }

  static async createPlan(data) {
    const key = (data.key || '').toString().trim().toLowerCase();
    if (!key) {
      const error = new Error('PLAN_KEY_REQUIRED');
      error.code = 'PLAN_KEY_REQUIRED';
      throw error;
    }

    const existing = await prisma.subscriptionPlanCatalog.findUnique({ where: { key } });
    if (existing) {
      const error = new Error('PLAN_KEY_EXISTS');
      error.code = 'PLAN_KEY_EXISTS';
      throw error;
    }

    const row = await prisma.subscriptionPlanCatalog.create({ data: toCreateData(data) });
    return planToApi(row);
  }

  static async updatePlan(key, data) {
    const normalized = normalizePlanInput(data);
    delete normalized.key;

    try {
      const row = await prisma.subscriptionPlanCatalog.update({
        where: { key: String(key).toLowerCase() },
        data: normalized
      });
      return planToApi(row);
    } catch (error) {
      if (error.code === 'P2025') {
        const notFound = new Error('PLAN_NOT_FOUND');
        notFound.code = 'PLAN_NOT_FOUND';
        throw notFound;
      }
      throw error;
    }
  }

  static async deletePlan(key) {
    try {
      const row = await prisma.subscriptionPlanCatalog.delete({
        where: { key: String(key).toLowerCase() }
      });
      return planToApi(row);
    } catch (error) {
      if (error.code === 'P2025') {
        const notFound = new Error('PLAN_NOT_FOUND');
        notFound.code = 'PLAN_NOT_FOUND';
        throw notFound;
      }
      throw error;
    }
  }

  static async seedDefaultPlans() {
    for (const plan of DEFAULT_PLANS) {
      const normalized = toCreateData(plan);
      await prisma.subscriptionPlanCatalog.upsert({
        where: { key: plan.key },
        create: normalized,
        update: {}
      });
    }
  }
}

module.exports = SubscriptionPlanService;
