'use strict';

const { AI_DOMAINS } = require('../shared/interfaces');
const { createFact } = require('../shared/factFactory');
const {
  requireNumericFact,
  collectSourceIds,
  collectSourceRecordIds,
} = require('./factLookup');

const KNOWLEDGE_MODEL_VERSION = 'kubika-knowledge-model-v1';

function safeDivide(numerator, denominator) {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator === 0) return null;
  return numerator / denominator;
}

function derivedFact({ companyId, label, value, unit, formula, inputFacts, permissions, metadata }) {
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
  const grossProfit = requireNumericFact(context.facts, 'Gross profit');
  const revenue = requireNumericFact(context.facts, 'Profit and loss revenue');
  if (grossProfit.missing || revenue.missing) return { missing: [grossProfit.missing, revenue.missing].filter(Boolean) };

  const ratio = safeDivide(grossProfit.value, revenue.value);
  if (ratio === null) return { missing: ['Non-zero revenue'] };

  const inputFacts = [grossProfit.fact, revenue.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Gross margin percent',
      value: Number((ratio * 100).toFixed(2)),
      unit: 'percent',
      formula: 'Gross margin percent = gross profit / revenue * 100',
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

  const dso = safeDivide(outstanding.value, revenue.value);
  if (dso === null) return { missing: ['Non-zero sales revenue for selected period'] };

  const inputFacts = [outstanding.fact, revenue.fact];
  return {
    fact: derivedFact({
      companyId: getCompanyId(context),
      label: 'Days sales outstanding estimate',
      value: Number((dso * 30).toFixed(2)),
      unit: 'days',
      formula: 'Days sales outstanding estimate = outstanding receivables / selected-period revenue * 30',
      inputFacts,
      permissions: firstPermissions(inputFacts),
      metadata: { kpiId: 'days_sales_outstanding' },
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
    requiredFactLabels: ['Profit and loss revenue', 'Cost of goods sold'],
    compute: computeGrossProfit,
  },
  gross_margin_pct: {
    id: 'gross_margin_pct',
    label: 'Gross margin percent',
    domain: AI_DOMAINS.FINANCE,
    requiredFactLabels: ['Gross profit', 'Profit and loss revenue'],
    compute: computeGrossMargin,
  },
  net_profit: {
    id: 'net_profit',
    label: 'Net profit',
    domain: AI_DOMAINS.FINANCE,
    requiredFactLabels: ['Profit and loss net profit'],
    compute: computeNetProfit,
  },
  stockout_risk_count: {
    id: 'stockout_risk_count',
    label: 'Stockout risk count',
    domain: AI_DOMAINS.INVENTORY,
    requiredFactLabels: ['Low stock product count', 'Out of stock product count'],
    compute: computeStockoutRisk,
  },
  inventory_value_per_product: {
    id: 'inventory_value_per_product',
    label: 'Inventory value per product',
    domain: AI_DOMAINS.INVENTORY,
    requiredFactLabels: ['Total stock value', 'Total active products'],
    compute: computeInventoryValuePerProduct,
  },
  days_sales_outstanding: {
    id: 'days_sales_outstanding',
    label: 'Days sales outstanding estimate',
    domain: AI_DOMAINS.CUSTOMERS,
    requiredFactLabels: ['Total client outstanding balance', 'Sales revenue for selected period'],
    compute: computeDaysSalesOutstanding,
  },
  vat_collected_estimate: {
    id: 'vat_collected_estimate',
    label: 'VAT collected estimate',
    domain: AI_DOMAINS.TAX,
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

