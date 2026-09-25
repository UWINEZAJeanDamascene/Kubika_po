'use strict';

const { AI_DOMAINS } = require('../shared/interfaces');
const { createFact } = require('../shared/factFactory');
const {
  requireNumericFact,
  latestFactByLabel,
  collectSourceIds,
  collectSourceRecordIds,
} = require('./factLookup');

const KNOWLEDGE_MODEL_VERSION = 'kubika-knowledge-model-v1';

function safeDivide(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function requireNumericFactAny(facts, labels) {
  for (const label of labels) {
    const result = requireNumericFact(facts, label);
    if (!result.missing) return result;
  }
  return { value: null, fact: null, missing: labels.join(' or ') };
}

function periodLengthDays(context, fallback = 30) {
  const from = context.metadata?.dateRange?.from;
  const to = context.metadata?.dateRange?.to;
  if (!from || !to) return { days: fallback, assumed: true };
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { days: fallback, assumed: true };
  }
  return { days: Math.max(1, Math.floor((end - start) / 86400000) + 1), assumed: false };
}

function derivedFact({ companyId, label, value, unit, formula, inputFacts, permissions, metadata }) {
  const inputMetadata = inputFacts.map((fact) => fact.metadata || {});
  const caveats = [
    ...(Array.isArray(metadata?.caveats) ? metadata.caveats : []),
    ...(metadata?.caveat ? [metadata.caveat] : []),
    ...inputMetadata.flatMap((item) => [
    ...(Array.isArray(item.caveats) ? item.caveats : []),
    ...(item.caveat ? [item.caveat] : []),
    ]),
  ];
  return createFact({
    companyId,
    domain: AI_DOMAINS.REPORTS,
    label,
    value,
    unit,
    sourceService: 'KnowledgeModel',
    sourceMethod: 'KPIRegistry',
    sourceIds: collectSourceRecordIds(inputFacts),
    computed: true,
    formula,
    permissions,
    metadata: {
      ...metadata,
      inputFactIds: collectSourceIds(inputFacts),
      knowledgeModelVersion: KNOWLEDGE_MODEL_VERSION,
      formulaTrace: {
        formula,
        inputs: inputFacts.map((fact) => ({
          factId: fact.id,
          label: fact.label,
          value: fact.value,
          unit: fact.unit || null,
          sourceService: fact.sourceService,
          sourceMethod: fact.sourceMethod,
          sourceIds: fact.sourceIds || [],
        })),
      },
      ...(caveats.length ? { caveats: Array.from(new Set(caveats)) } : {}),
    },
  });
}

function getCompanyId(context) {
  return String(context.companyId || context.facts?.[0]?.companyId || '');
}

function firstPermissions(inputFacts) {
  const permissions = new Set();
  for (const fact of inputFacts) {
    for (const permission of fact?.permissions || []) permissions.add(permission);
  }
  return Array.from(permissions);
}

function computeGrossProfit(context) {
  const revenue = requireNumericFact(context.facts, 'Profit and loss revenue');
  const cogs = requireNumericFact(context.facts, 'Cost of goods sold');
  if (revenue.missing || cogs.missing) return { missing: [revenue.missing, cogs.missing].filter(Boolean) };

  const inputFacts = [revenue.fact, cogs.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Gross profit',
      value: revenue.value - cogs.value,
      unit: 'RWF',
      formula: 'Gross profit = revenue - cost of goods sold',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: { kpiId: 'gross_profit' },
    }),
  };
}

function computeGrossMargin(context) {
  const revenue = requireNumericFact(context.facts, 'Profit and loss revenue');
  const cogs = requireNumericFact(context.facts, 'Cost of goods sold');
  if (revenue.missing || cogs.missing) return { missing: [revenue.missing, cogs.missing].filter(Boolean) };

  const ratio = safeDivide(revenue.value - cogs.value, revenue.value);
  if (ratio === null) return { missing: ['Non-zero revenue'] };

  const inputFacts = [revenue.fact, cogs.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Gross margin percent',
      value: Number((ratio * 100).toFixed(2)),
      unit: 'percent',
      formula: 'Gross margin percent = (revenue - cost of goods sold) / revenue * 100',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: { kpiId: 'gross_margin_pct' },
    }),
  };
}

function computeNetProfit(context) {
  const netProfit = requireNumericFact(context.facts, 'Profit and loss net profit');
  if (netProfit.missing) return { missing: [netProfit.missing] };

  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Net profit',
      value: netProfit.value,
      unit: 'RWF',
      formula: 'Net profit = profit and loss net profit from existing report service',
      inputFacts: [netProfit.fact],
      permissions: firstPermissions([netProfit.fact]),
      metadata: { kpiId: 'net_profit' },
    }),
  };
}

function computeStockoutRisk(context) {
  const lowStock = requireNumericFact(context.facts, 'Low stock product count');
  const outOfStock = requireNumericFact(context.facts, 'Out of stock product count');
  if (lowStock.missing || outOfStock.missing) return { missing: [lowStock.missing, outOfStock.missing].filter(Boolean) };

  const inputFacts = [lowStock.fact, outOfStock.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Stockout risk count',
      value: lowStock.value + outOfStock.value,
      unit: 'count',
      formula: 'Stockout risk count = low stock product count + out of stock product count',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: { kpiId: 'stockout_risk_count' },
    }),
  };
}

function computeInventoryValuePerProduct(context) {
  const value = requireNumericFact(context.facts, 'Total stock value');
  const count = requireNumericFact(context.facts, 'Total active products');
  if (value.missing || count.missing) return { missing: [value.missing, count.missing].filter(Boolean) };

  const average = safeDivide(value.value, count.value);
  if (average === null) return { missing: ['Non-zero total active products'] };

  const inputFacts = [value.fact, count.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Inventory value per product',
      value: Number(average.toFixed(2)),
      unit: 'RWF',
      formula: 'Inventory value per product = total stock value / total active products',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: { kpiId: 'inventory_value_per_product' },
    }),
  };
}

function computeDaysSalesOutstanding(context) {
  const outstanding = requireNumericFact(context.facts, 'Total client outstanding balance');
  const revenue = requireNumericFact(context.facts, 'Sales revenue for selected period');
  if (outstanding.missing || revenue.missing) return { missing: [outstanding.missing, revenue.missing].filter(Boolean) };

  const period = periodLengthDays(context);
  const dso = safeDivide(outstanding.value * period.days, revenue.value);
  if (dso === null) return { missing: ['Non-zero sales revenue for selected period'] };

  const inputFacts = [outstanding.fact, revenue.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Days sales outstanding estimate',
      value: Number(dso.toFixed(2)),
      unit: 'days',
      formula: `Days sales outstanding estimate = outstanding receivables / selected-period revenue * ${period.days} days`,
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: {
        kpiId: 'days_sales_outstanding',
        caveats: [
          'Ending receivables balance is used as a proxy for average receivables.',
          ...(period.assumed ? ['A 30-day period was assumed because the selected date range was unavailable.'] : []),
        ],
      },
    }),
  };
}

function computeInventoryTurnover(context) {
  const cogs = requireNumericFact(context.facts, 'Cost of goods sold');
  const averageInventory = requireNumericFactAny(context.facts, ['Average inventory value', 'Total stock value']);
  if (cogs.missing || averageInventory.missing) {
    return { missing: [cogs.missing, averageInventory.missing].filter(Boolean) };
  }

  const turnover = safeDivide(cogs.value, averageInventory.value);
  if (turnover === null) return { missing: ['Non-zero average inventory value'] };
  const inputFacts = [cogs.fact, averageInventory.fact];
  const usedEndingValue = averageInventory.fact.label === 'Total stock value';
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Inventory turnover',
      value: Number(turnover.toFixed(2)),
      unit: 'turns',
      formula: 'Inventory turnover = cost of goods sold / average inventory value',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: {
        kpiId: 'inventory_turnover',
        ...(usedEndingValue ? { caveat: 'Ending inventory value was used as a proxy because average inventory value was unavailable.' } : {}),
      },
    }),
  };
}

function computeDaysPayableOutstanding(context) {
  const payables = requireNumericFact(context.facts, 'Total supplier outstanding balance');
  const purchases = requireNumericFact(context.facts, 'Purchases for selected period');
  if (payables.missing || purchases.missing) return { missing: [payables.missing, purchases.missing].filter(Boolean) };

  const period = periodLengthDays(context);
  const dpo = safeDivide(payables.value * period.days, purchases.value);
  if (dpo === null) return { missing: ['Non-zero purchases for selected period'] };
  const inputFacts = [payables.fact, purchases.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Days payable outstanding estimate',
      value: Number(dpo.toFixed(2)),
      unit: 'days',
      formula: `Days payable outstanding estimate = outstanding payables / selected-period purchases * ${period.days} days`,
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: {
        kpiId: 'days_payable_outstanding',
        caveats: [
          'Ending payables balance is used as a proxy for average payables.',
          ...(period.assumed ? ['A 30-day period was assumed because the selected date range was unavailable.'] : []),
        ],
      },
    }),
  };
}

function computeDeadStock(context) {
  const deadStock = requireNumericFact(context.facts, 'Dead stock candidate count');
  if (deadStock.missing) return { missing: [deadStock.missing] };
  const windowDays = Number(deadStock.fact.metadata?.deadStockWindowDays) || 60;
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Dead stock product count',
      value: deadStock.value,
      unit: 'count',
      formula: `Dead stock product count = products with zero outbound movement in the trailing ${windowDays} days`,
      inputFacts: [deadStock.fact],
      permissions: firstPermissions([deadStock.fact]),
      metadata: { kpiId: 'dead_stock_count', deadStockWindowDays: windowDays },
    }),
  };
}

function computeVatCollected(context) {
  const vat = requireNumericFact(context.facts, 'VAT collected for selected period');
  if (vat.missing) return { missing: [vat.missing] };
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'VAT collected',
      value: vat.value,
      unit: 'RWF',
      formula: 'VAT collected = verified output VAT total from the existing tax report service',
      inputFacts: [vat.fact],
      permissions: firstPermissions([vat.fact]),
      metadata: { kpiId: 'vat_collected' },
    }),
  };
}

function computeVatPayable(context) {
  const payable = requireNumericFact(context.facts, 'VAT payable for selected period');
  if (payable.missing) return { missing: [payable.missing] };
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'VAT payable',
      value: payable.value,
      unit: 'RWF',
      formula: 'VAT payable = output VAT less input VAT from the existing tax report service',
      inputFacts: [payable.fact],
      permissions: firstPermissions([payable.fact]),
      metadata: { kpiId: 'vat_payable' },
    }),
  };
}

function computePayrollCostRatio(context) {
  const payroll = requireNumericFact(context.facts, 'Payroll employer cost for selected period');
  const revenue = requireNumericFact(context.facts, 'Profit and loss revenue');
  if (payroll.missing || revenue.missing) return { missing: [payroll.missing, revenue.missing].filter(Boolean) };
  const ratio = safeDivide(payroll.value, revenue.value);
  if (ratio === null) return { missing: ['Non-zero revenue for selected period'] };
  const inputFacts = [payroll.fact, revenue.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Payroll cost ratio',
      value: Number((ratio * 100).toFixed(2)),
      unit: 'percent',
      formula: 'Payroll cost ratio = employer payroll cost / revenue for the same selected period * 100',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: { kpiId: 'payroll_cost_ratio' },
    }),
  };
}

function computeVatCollectedEstimate(context) {
  const revenue = requireNumericFact(context.facts, 'Sales revenue for selected period');
  if (revenue.missing) return { missing: [revenue.missing] };

  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'VAT collected estimate',
      value: Number((revenue.value * 0.18).toFixed(2)),
      unit: 'RWF',
      formula: 'VAT collected estimate = selected-period sales revenue * 18%',
      inputFacts: [revenue.fact],
      permissions: firstPermissions([revenue.fact]),
      metadata: { kpiId: 'vat_collected_estimate', caveat: 'Estimate assumes all selected revenue is Tax B taxable at 18%.' },
    }),
  };
}

const KPI_REGISTRY = Object.freeze({
  gross_profit: {
    id: 'gross_profit',
    label: 'Gross profit',
    domain: AI_DOMAINS.FINANCE,
    unit: 'RWF',
    formula: 'revenue - cost of goods sold',
    requiredFactLabels: ['Profit and loss revenue', 'Cost of goods sold'],
    compute: computeGrossProfit,
  },
  gross_margin_pct: {
    id: 'gross_margin_pct',
    label: 'Gross margin percent',
    domain: AI_DOMAINS.FINANCE,
    unit: 'percent',
    formula: '(revenue - cost of goods sold) / revenue * 100',
    requiredFactLabels: ['Profit and loss revenue', 'Cost of goods sold'],
    compute: computeGrossMargin,
  },
  net_profit: {
    id: 'net_profit',
    label: 'Net profit',
    domain: AI_DOMAINS.FINANCE,
    unit: 'RWF',
    formula: 'net profit from the existing profit and loss report service',
    requiredFactLabels: ['Profit and loss net profit'],
    compute: computeNetProfit,
  },
  inventory_turnover: {
    id: 'inventory_turnover',
    label: 'Inventory turnover',
    domain: AI_DOMAINS.INVENTORY,
    unit: 'turns',
    formula: 'cost of goods sold / average inventory value',
    requiredFactLabels: ['Cost of goods sold', 'Average inventory value or Total stock value'],
    compute: computeInventoryTurnover,
  },
  days_sales_outstanding: {
    id: 'days_sales_outstanding',
    label: 'Days sales outstanding estimate',
    domain: AI_DOMAINS.CUSTOMERS,
    unit: 'days',
    formula: 'outstanding receivables / selected-period revenue * period days',
    requiredFactLabels: ['Total client outstanding balance', 'Sales revenue for selected period'],
    compute: computeDaysSalesOutstanding,
  },
  days_payable_outstanding: {
    id: 'days_payable_outstanding',
    label: 'Days payable outstanding estimate',
    domain: AI_DOMAINS.PURCHASES,
    unit: 'days',
    formula: 'outstanding payables / selected-period purchases * period days',
    requiredFactLabels: ['Total supplier outstanding balance', 'Purchases for selected period'],
    compute: computeDaysPayableOutstanding,
  },
  stockout_risk_count: {
    id: 'stockout_risk_count',
    label: 'Stockout risk count',
    domain: AI_DOMAINS.INVENTORY,
    unit: 'count',
    formula: 'low stock product count + out of stock product count',
    requiredFactLabels: ['Low stock product count', 'Out of stock product count'],
    compute: computeStockoutRisk,
  },
  dead_stock_count: {
    id: 'dead_stock_count',
    label: 'Dead stock product count',
    domain: AI_DOMAINS.INVENTORY,
    unit: 'count',
    formula: 'count supplied by the inventory service using the registered dead-stock definition',
    requiredFactLabels: ['Dead stock candidate count'],
    compute: computeDeadStock,
  },
  vat_collected: {
    id: 'vat_collected',
    label: 'VAT collected',
    domain: AI_DOMAINS.TAX,
    unit: 'RWF',
    formula: 'verified output VAT total from the existing tax report service',
    requiredFactLabels: ['VAT collected for selected period'],
    compute: computeVatCollected,
  },
  vat_payable: {
    id: 'vat_payable',
    label: 'VAT payable',
    domain: AI_DOMAINS.TAX,
    unit: 'RWF',
    formula: 'output VAT less input VAT from the existing tax report service',
    requiredFactLabels: ['VAT payable for selected period'],
    compute: computeVatPayable,
  },
  payroll_cost_ratio: {
    id: 'payroll_cost_ratio',
    label: 'Payroll cost ratio',
    domain: AI_DOMAINS.PAYROLL,
    unit: 'percent',
    formula: 'employer payroll cost / revenue for the same selected period * 100',
    requiredFactLabels: ['Payroll employer cost for selected period', 'Profit and loss revenue'],
    compute: computePayrollCostRatio,
  },
  inventory_value_per_product: {
    id: 'inventory_value_per_product',
    label: 'Inventory value per product',
    domain: AI_DOMAINS.INVENTORY,
    unit: 'RWF',
    formula: 'total stock value / total active products',
    requiredFactLabels: ['Total stock value', 'Total active products'],
    compute: computeInventoryValuePerProduct,
  },
  vat_collected_estimate: {
    id: 'vat_collected_estimate',
    label: 'VAT collected estimate',
    domain: AI_DOMAINS.TAX,
    unit: 'RWF',
    formula: 'selected-period sales revenue * 18%',
    requiredFactLabels: ['Sales revenue for selected period'],
    compute: computeVatCollectedEstimate,
  },
});

function getKpiDefinition(kpiId) {
  return KPI_REGISTRY[kpiId] || null;
}

function listKpis() {
  return Object.values(KPI_REGISTRY).map(({ compute, ...definition }) => definition);
}

function computeKpi(context, kpiId) {
  const definition = getKpiDefinition(kpiId);
  if (!definition) {
    return { fact: null, missing: [], error: `Unknown KPI: ${kpiId}` };
  }
  const result = definition.compute(context);
  return {
    fact: result.fact || null,
    missing: result.missing || [],
    error: result.error || null,
    definition: listKpis().find((kpi) => kpi.id === kpiId),
  };
}

function computeKpis(context, kpiIds = Object.keys(KPI_REGISTRY)) {
  const computedFacts = [];
  const missing = {};
  const errors = {};
  const enrichedContext = { ...context, facts: [...(context.facts || [])] };

  for (const kpiId of kpiIds) {
    const result = computeKpi(enrichedContext, kpiId);
    if (result.fact) {
      computedFacts.push(result.fact);
      enrichedContext.facts.push(result.fact);
    }
    if (result.missing && result.missing.length) missing[kpiId] = result.missing;
    if (result.error) errors[kpiId] = result.error;
  }

  return { facts: computedFacts, missing, errors };
}

function enrichContextWithKpis(context, kpiIds) {
  const result = computeKpis(context, kpiIds);
  return {
    ...context,
    facts: [...(context.facts || []), ...result.facts],
    warnings: [
      ...(context.warnings || []),
      ...Object.entries(result.missing).map(([kpiId, labels]) => `KPI '${kpiId}' missing required facts: ${labels.join(', ')}`),
      ...Object.entries(result.errors).map(([kpiId, error]) => `KPI '${kpiId}' failed: ${error}`),
    ],
    metadata: {
      ...(context.metadata || {}),
      knowledgeModelVersion: KNOWLEDGE_MODEL_VERSION,
      computedKpis: result.facts.map((fact) => fact.label),
      missingKpis: result.missing,
      kpiErrors: result.errors,
    },
  };
}

module.exports = {
  KNOWLEDGE_MODEL_VERSION,
  KPI_REGISTRY,
  getKpiDefinition,
  listKpis,
  computeKpi,
  computeKpis,
  enrichContextWithKpis,
};
