'use strict';

const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { buildContext } = require('../ai-engine/context-builder/ContextBuilder');
const { extractUserPermissions, hasPermission } = require('../ai-engine/context-builder/permissionUtils');
const { DOMAIN_PERMISSIONS } = require('../ai-engine/monitoring/MonitoringEngine');
const {
  FORECAST_MODEL_VERSION,
  makeMonthlySeries,
  forecastSeries,
  insufficientConfidenceInterval,
} = require('../ai-engine/predictive/ForecastEngine');

const FORECAST_TYPES = Object.freeze({
  revenue: { title: 'Revenue Forecast', domains: ['sales'], permissionDomains: ['sales'] },
  cash_balance: { title: 'Cash Balance Forecast', domains: ['finance'], permissionDomains: ['finance'] },
  inventory_stockout: { title: 'Inventory Stockout Forecast', domains: ['inventory'], permissionDomains: ['inventory'] },
  receivable_collection: { title: 'Receivable Collection Risk Forecast', domains: ['customers', 'finance'], permissionDomains: ['customers', 'finance'] },
  payable_pressure: { title: 'Payable Pressure Forecast', domains: ['purchases', 'finance'], permissionDomains: ['purchases', 'finance'] },
});

function normalizedOptions({ historyMonths = 24, horizon = 3 } = {}) {
  const months = Number(historyMonths);
  const periods = Number(horizon);
  return {
    historyMonths: Number.isInteger(months) ? Math.max(3, Math.min(60, months)) : 24,
    horizon: Number.isInteger(periods) ? Math.max(1, Math.min(12, periods)) : 3,
  };
}

function rangeForMonths(months, now = new Date()) {
  // Use completed months so a partial current month is not mistaken for zero demand.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
  const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months + 1, 1));
  return { from: from.toISOString(), to: end.toISOString(), referenceDate: now.toISOString() };
}

function fact(context, label) {
  return (context.facts || []).find((row) => row.label === label) || null;
}

function factSeries(source, { from, to, rowsKey, valueField }) {
  const rows = rowsKey
    ? source?.value?.[rowsKey] || []
    : Array.isArray(source?.value) ? source.value : [];
  return makeMonthlySeries(rows, { from, to, periodField: 'period', valueField });
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function forecastRevenue(context, options, dateRange) {
  const timelineFact = fact(context, 'Sales timeline for selected period');
  const series = factSeries(timelineFact, { ...dateRange, valueField: 'revenue' });
  const model = forecastSeries(series, options.horizon);
  return {
    status: model.status,
    method: model.method,
    confidence: model.confidence,
    unit: 'RWF',
    predictions: model.predictions.map((prediction) => ({
      ...prediction,
      value: Math.max(0, prediction.value),
      confidenceInterval: {
        ...prediction.confidenceInterval,
        lower: Math.max(0, prediction.confidenceInterval.lower),
        upper: Math.max(0, prediction.confidenceInterval.upper),
      },
      sourceFactIds: timelineFact ? [timelineFact.id] : [],
    })),
    observations: model.observations,
    confidenceInterval: model.predictions[0]?.confidenceInterval || insufficientConfidenceInterval('No historical revenue observations were returned.'),
    backtestMetrics: model.backtestMetrics,
    sourceFactIds: timelineFact ? [timelineFact.id] : [],
    assumptions: [
      'Monthly invoice revenue is used as the observed series; months without a returned invoice aggregate are treated as zero.',
      'The selected moving-average, linear-trend, or seasonal baseline continues over the forecast horizon.',
      'Prediction intervals are approximate and do not guarantee future revenue.',
    ],
  };
}

function forecastCashBalance(context, options, dateRange) {
  const historyFact = fact(context, 'Cash movement history');
  const balanceFact = fact(context, 'Cash and bank account balance');
  const series = factSeries(historyFact, { ...dateRange, rowsKey: 'monthly', valueField: 'netChange' });
  const model = forecastSeries(series, options.horizon);
  const predictions = [];
  let projected = Number(balanceFact?.value || 0);
  let cumulativeVariance = 0;
  const sourceFactIds = [historyFact?.id, balanceFact?.id].filter(Boolean);
  for (const prediction of model.predictions) {
    projected += prediction.value;
    const interval = prediction.confidenceInterval;
    const halfWidth = (Number(interval.upper) - Number(interval.lower)) / (2 * 1.96);
    cumulativeVariance += halfWidth ** 2;
    const cumulativeError = 1.96 * Math.sqrt(cumulativeVariance);
    predictions.push({
      period: prediction.period,
      value: round(projected),
      netCashChange: prediction.value,
      confidenceInterval: {
        level: 0.95,
        lower: round(projected - cumulativeError),
        upper: round(projected + cumulativeError),
        type: interval.type,
      },
      sourceFactIds,
    });
  }
  return {
    status: model.status,
    method: model.method,
    confidence: model.confidence,
    unit: 'RWF',
    predictions,
    observations: model.observations,
    confidenceInterval: predictions[0]?.confidenceInterval || insufficientConfidenceInterval('Cash transactions or current account balance were unavailable.'),
    backtestMetrics: model.backtestMetrics,
    sourceFactIds: [historyFact?.id, balanceFact?.id].filter(Boolean),
    assumptions: [
      'Current bank account balance is the opening forecast balance.',
      'Posted, unreversed bank transactions represent cash movement; future deposits and withdrawals follow the historical baseline.',
      'No new financing, unrecorded cash activity, or future manual adjustments are included.',
      'Intervals combine approximate monthly prediction errors and are not guaranteed outcomes.',
    ],
  };
}

function addDays(date, days) {
  return new Date(date.getTime() + Math.max(0, days) * 24 * 60 * 60 * 1000).toISOString();
}

function forecastInventory(context, options, dateRange) {
  const historyFact = fact(context, 'Inventory demand history');
  const history = historyFact?.value || {};
  const from = new Date(dateRange.from);
  const to = new Date(dateRange.referenceDate || dateRange.to);
  const observedDays = Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)));
  const products = (history.products || []).slice(0, 100).map((product) => {
    const series = makeMonthlySeries(product.monthly || [], { from: dateRange.from, to: dateRange.to, valueField: 'units' });
    const model = forecastSeries(series, options.horizon);
    const currentStock = Math.max(0, Number(product.currentStock || 0) - Number(product.reservedQuantity || 0));
    const nextDemand = model.predictions[0];
    const sourceFactIds = historyFact ? [historyFact.id] : [];
    if (currentStock <= 0) {
      return {
        productId: product.productId, productName: product.productName, sku: product.sku,
        currentStock, status: 'already_out_of_stock', estimatedStockoutDate: null,
        stockoutDateInterval: insufficientConfidenceInterval('Product is already out of stock.'),
        demandMethod: model.method, sourceFactIds,
      };
    }
    if (!nextDemand || Number(nextDemand.value) <= 0) {
      return {
        productId: product.productId, productName: product.productName, sku: product.sku,
        currentStock, status: 'no_recent_sales', estimatedStockoutDate: null,
        stockoutDateInterval: insufficientConfidenceInterval('No positive monthly sale demand was observed.'),
        demandMethod: model.method, sourceFactIds,
      };
    }
    const daysInMonth = new Date(Date.UTC(Number(nextDemand.period.slice(0, 4)), Number(nextDemand.period.slice(5, 7)), 0)).getUTCDate();
    const dailyDemand = nextDemand.value / daysInMonth;
    const estimatedDays = currentStock / dailyDemand;
    const highMonthlyDemand = Math.max(0, Number(nextDemand.confidenceInterval.upper));
    const lowMonthlyDemand = Math.max(0, Number(nextDemand.confidenceInterval.lower));
    const earliestDays = highMonthlyDemand > 0 ? (currentStock / (highMonthlyDemand / daysInMonth)) : null;
    const latestDays = lowMonthlyDemand > 0 ? (currentStock / (lowMonthlyDemand / daysInMonth)) : null;
    return {
      productId: product.productId,
      productName: product.productName,
      sku: product.sku,
      currentStock,
      averageDailyDemand: round(dailyDemand),
      estimatedStockoutDate: addDays(to, estimatedDays),
      estimatedDaysRemaining: Math.max(0, Math.round(estimatedDays)),
      stockoutDateInterval: {
        available: earliestDays != null || latestDays != null,
        level: 0.95,
        earliest: earliestDays != null ? addDays(to, earliestDays) : null,
        latest: latestDays != null ? addDays(to, latestDays) : null,
        type: nextDemand.confidenceInterval.type,
        reason: lowMonthlyDemand <= 0 ? 'Upper date bound is open because the demand interval includes zero.' : undefined,
      },
      demandForecast: model.predictions,
      demandMethod: model.method,
      confidence: model.confidence,
      backtestMetrics: model.backtestMetrics,
      sourceFactIds,
    };
  });
  return {
    status: products.some((product) => product.status === 'forecasted' || product.estimatedStockoutDate) ? 'forecasted' : 'insufficient_data',
    method: 'per-product monthly sale demand baseline',
    confidence: products.some((product) => product.confidence === 'medium') ? 'medium' : products.length ? 'low' : 'none',
    unit: 'date',
    predictions: products,
    observations: history.products || [],
    confidenceInterval: products[0]?.stockoutDateInterval || insufficientConfidenceInterval('No product sales movement history was available.'),
    backtestMetrics: products.map((product) => ({ productId: product.productId, metrics: product.backtestMetrics || { available: false } })),
    sourceFactIds: historyFact ? [historyFact.id] : [],
    assumptions: [
      'Only stock movements marked as outbound sales are used to estimate product demand.',
      'Available stock is current stock less recorded reservations; both are assumed current through the forecast reference date.',
      'No replenishment, reservations, damage, theft, or transfer activity after the reference date is modeled.',
      'Stockout intervals inherit the demand model interval and can be open-ended when its lower demand bound is zero.',
    ],
    metadata: { observedDays, truncatedHistory: Boolean(history.truncated) },
  };
}

function currentReceivables(context) {
  const totalFact = fact(context, 'Total client outstanding balance');
  const agingFact = fact(context, 'Receivables aging');
  return {
    total: Number(totalFact?.value || agingFact?.value?.totalOutstanding || 0),
    overdue: Object.entries(agingFact?.value?.buckets || {})
      .filter(([name]) => name !== 'current')
      .reduce((sum, [, value]) => sum + Number(value?.amount ?? value ?? 0), 0),
    ids: [totalFact?.id, agingFact?.id].filter(Boolean),
  };
}

function currentPayables(context) {
  const totalFact = fact(context, 'Total supplier outstanding balance');
  const agingFact = fact(context, 'Payables aging');
  return {
    total: Number(totalFact?.value || agingFact?.value?.summary?.totalAP || 0),
    ids: [totalFact?.id, agingFact?.id].filter(Boolean),
  };
}

function forecastBalanceAfterPayments(context, options, dateRange, { historyLabel, seriesKey, valueField, balance, sourceIds, assumption }) {
  const historyFact = fact(context, historyLabel);
  const series = factSeries(historyFact, { ...dateRange, rowsKey: seriesKey, valueField });
  const model = forecastSeries(series, options.horizon);
  let remaining = Number(balance || 0);
  let cumulativeVariance = 0;
  const predictions = model.predictions.map((prediction) => {
    remaining = Math.max(0, remaining - Math.max(0, prediction.value));
    const halfWidth = (Number(prediction.confidenceInterval.upper) - Number(prediction.confidenceInterval.lower)) / (2 * 1.96);
    cumulativeVariance += halfWidth ** 2;
    const cumulativeError = 1.96 * Math.sqrt(cumulativeVariance);
    return {
      period: prediction.period,
      value: round(remaining),
      projectedPayments: prediction.value,
      confidenceInterval: {
        level: 0.95,
        lower: round(Math.max(0, remaining - cumulativeError)),
        upper: round(Math.max(0, remaining + cumulativeError)),
        type: prediction.confidenceInterval.type,
      },
      sourceFactIds: [...sourceIds, historyFact?.id].filter(Boolean),
    };
  });
  return {
    status: model.status,
    method: model.method,
    confidence: model.confidence,
    unit: 'RWF',
    predictions,
    observations: model.observations,
    confidenceInterval: predictions[0]?.confidenceInterval || insufficientConfidenceInterval('Payment history or current outstanding balance was unavailable.'),
    backtestMetrics: model.backtestMetrics,
    sourceFactIds: [...sourceIds, historyFact?.id].filter(Boolean),
    assumptions: [assumption, 'No new invoices, purchases, credits, write-offs, or payments other than forecasted payments are modeled.', 'Intervals are approximate and do not guarantee future outcomes.'],
  };
}

function buildForecast(context, forecastType, options, dateRange) {
  if (forecastType === 'revenue') return forecastRevenue(context, options, dateRange);
  if (forecastType === 'cash_balance') return forecastCashBalance(context, options, dateRange);
  if (forecastType === 'inventory_stockout') return forecastInventory(context, options, dateRange);
  if (forecastType === 'receivable_collection') {
    const current = currentReceivables(context);
    return forecastBalanceAfterPayments(context, options, dateRange, {
      historyLabel: 'Receivables collection history', seriesKey: 'monthly', valueField: 'collected',
      balance: current.total, sourceIds: current.ids,
      assumption: `Projected receivables subtract forecast posted customer collections from the current outstanding balance (${round(current.overdue)} currently overdue); no new credit sales are included.`,
    });
  }
  if (forecastType === 'payable_pressure') {
    const current = currentPayables(context);
    return forecastBalanceAfterPayments(context, options, dateRange, {
      historyLabel: 'Payables payment history', seriesKey: 'monthly', valueField: 'paid',
      balance: current.total, sourceIds: current.ids,
      assumption: `Projected payables subtract forecast posted supplier payments from the current outstanding balance (${round(current.total)}); no new purchases are included.`,
    });
  }
  throw Object.assign(new Error('Unsupported forecast type.'), { statusCode: 400 });
}

function visibleForecast(forecast, permissions) {
  const sourceFacts = (forecast.sourceFacts || []).filter((source) =>
    Array.isArray(source.permissions) && source.permissions.length && hasPermission(permissions, source.permissions));
  const visibleIds = new Set(sourceFacts.map((source) => source.id));
  const prediction = forecast.forecast || {};
  const predictions = Array.isArray(prediction.predictions)
    ? prediction.predictions.filter((item) => (item.sourceFactIds || []).every((id) => visibleIds.has(id)))
    : [];
  return {
    ...forecast,
    sourceFacts,
    forecast: { ...prediction, predictions },
    metadata: { ...(forecast.metadata || {}), sourceFactIds: Array.from(visibleIds) },
  };
}

async function generateForecast({ companyId, user, forecastType, horizon, historyMonths, now = new Date() }) {
  const definition = FORECAST_TYPES[forecastType];
  if (!definition) throw Object.assign(new Error(`Unsupported forecastType. Choose one of: ${Object.keys(FORECAST_TYPES).join(', ')}`), { statusCode: 400 });
  const options = normalizedOptions({ horizon, historyMonths });
  const permissions = extractUserPermissions(user);
  const allowedDomains = definition.domains.filter((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || []));
  if (!allowedDomains.length) throw Object.assign(new Error('You do not have read permission for this forecast.'), { statusCode: 403 });
  const dateRange = rangeForMonths(options.historyMonths, now);
  const unavailableDomains = definition.domains.filter((domain) => !allowedDomains.includes(domain));
  const context = await buildContext({
    user,
    company: String(companyId),
    query: `Generate ${definition.title}`,
    domains: allowedDomains,
    dateRange: { from: dateRange.from, to: dateRange.to },
    requestId: crypto.randomUUID(),
  });
  const forecast = buildForecast(context, forecastType, options, dateRange);
  const assumptions = [
    ...forecast.assumptions,
    ...(unavailableDomains.length ? [`Unavailable domains due to permissions: ${unavailableDomains.join(', ')}.`] : []),
    ...(context.warnings || []),
    ...(context.facts.length === 0 ? ['No source facts were available; no forecast should be interpreted as a business outcome.'] : []),
  ];
  const forecastId = `aifc_${generateObjectId()}`;
  const payload = {
    forecastId,
    companyId: String(companyId),
    createdBy: String(user.id || user._id),
    forecastType,
    dateRange: { from: dateRange.from, to: dateRange.to },
    horizon: options.horizon,
    status: forecast.status,
    method: forecast.method,
    confidence: forecast.confidence,
    forecast,
    assumptions,
    sourceFacts: context.facts,
    backtestMetrics: forecast.backtestMetrics || {},
    modelVersion: FORECAST_MODEL_VERSION,
    metadata: {
      title: definition.title,
      generatedAt: now.toISOString(),
      requestId: context.metadata.requestId,
      historyMonths: options.historyMonths,
      domainCoverage: context.metadata.domains,
      evidenceFactIds: context.facts.map((source) => source.id).filter(Boolean),
      ...(forecast.metadata || {}),
    },
  };
  const saved = await prisma.aIForecast.create({ data: { id: generateObjectId(), ...payload } });
  return visibleForecast({ ...saved, forecastId: saved.forecastId }, permissions);
}

async function listForecasts(companyId, permissions, { forecastType, limit } = {}) {
  const where = { companyId: String(companyId) };
  if (forecastType) {
    if (!FORECAST_TYPES[forecastType]) throw Object.assign(new Error('Unknown forecast type.'), { statusCode: 400 });
    where.forecastType = forecastType;
  }
  const parsedLimit = Number(limit);
  const rows = await prisma.aIForecast.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(100, Math.floor(parsedLimit)) : 25,
  });
  return rows
    .filter((row) => FORECAST_TYPES[row.forecastType]
      && FORECAST_TYPES[row.forecastType].permissionDomains.some((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || [])))
    .map((row) => visibleForecast(row, permissions));
}

async function getForecast(companyId, forecastId, permissions) {
  const row = await prisma.aIForecast.findUnique({
    where: { companyId_forecastId: { companyId: String(companyId), forecastId: String(forecastId) } },
  });
  if (!row || !FORECAST_TYPES[row.forecastType]) return null;
  if (!FORECAST_TYPES[row.forecastType].permissionDomains.some((domain) => hasPermission(permissions, DOMAIN_PERMISSIONS[domain] || []))) return null;
  return visibleForecast(row, permissions);
}

module.exports = {
  FORECAST_TYPES,
  normalizedOptions,
  rangeForMonths,
  buildForecast,
  visibleForecast,
  generateForecast,
  listForecasts,
  getForecast,
};
