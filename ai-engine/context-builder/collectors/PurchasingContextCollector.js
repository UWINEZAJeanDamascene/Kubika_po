'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { addNumericFact, createFact, sourceIdsFrom } = require('../factFactory');
const { runTool } = require('../toolRunner');
const MonthlyReportsService = require('../../../services/monthlyReportsService');

const REQUIRED_PERMISSIONS = ['purchases.read', 'suppliers.read', 'reports.read'];
const MAX_MONTHS = 24;

function parsePeriod(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function periodIsInRange(start, end, current) {
  const key = current.year * 12 + current.month;
  return key >= start.year * 12 + start.month && key <= end.year * 12 + end.month;
}

async function collect({ companyId, dateRange = {} }) {
  const facts = [];
  const warnings = [];
  const [{ result: purchases }, { result: suppliers }] = await Promise.all([
    runTool(companyId, 'get_purchases', {
      limit: 20,
      startDate: dateRange && dateRange.from,
      endDate: dateRange && dateRange.to,
    }),
    runTool(companyId, 'get_suppliers', { limit: 20 }),
  ]);

  addNumericFact(facts, {
    companyId,
    domain: AI_DOMAINS.PURCHASES,
    label: 'Purchase count for selected period',
    value: purchases.count || 0,
    unit: 'count',
    sourceMethod: 'get_purchases',
    sourceIds: sourceIdsFrom(purchases.purchases, 'get_purchases'),
    permissions: REQUIRED_PERMISSIONS,
  });

  if (Array.isArray(purchases.purchases)) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.PURCHASES,
      label: 'Recent purchases sample',
      value: purchases.purchases.slice(0, 10),
      sourceMethod: 'get_purchases',
      sourceIds: sourceIdsFrom(purchases.purchases, 'get_purchases'),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  if (Array.isArray(suppliers.suppliers)) {
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.SUPPLIERS,
      label: 'Supplier sample',
      value: suppliers.suppliers.slice(0, 10),
      sourceMethod: 'get_suppliers',
      sourceIds: sourceIdsFrom(suppliers.suppliers, 'get_suppliers'),
      permissions: REQUIRED_PERMISSIONS,
    }));
  }

  const now = new Date();
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const start = parsePeriod(dateRange.from) || parsePeriod(dateRange.to) || current;
  const end = parsePeriod(dateRange.to) || start;
  let period = { ...start };
  let lastProcessedPeriod = null;
  let monthCount = 0;
  let purchaseTotal = 0;
  let hasPurchaseTotal = false;
  const purchaseSourceIds = [];
  const periods = [];

  while (periodIsInRange(start, end, period) && monthCount < MAX_MONTHS) {
    lastProcessedPeriod = { ...period };
    const key = monthKey(period);
    try {
      const report = await MonthlyReportsService.getVATReturn(companyId, period.year, period.month);
      const value = Number(report?.summary?.totalPurchases);
      if (Number.isFinite(value)) {
        purchaseTotal += value;
        hasPurchaseTotal = true;
        purchaseSourceIds.push(`vat_return:purchases:${key}`);
        periods.push(key);
      }
    } catch (error) {
      warnings.push(`Purchases total report failed for ${key}: ${error.message}`);
    }
    monthCount += 1;
    period.month += 1;
    if (period.month > 12) {
      period.month = 1;
      period.year += 1;
    }
  }

  if (periodIsInRange(start, end, period)) {
    warnings.push(`Purchasing context is limited to the most recent ${MAX_MONTHS} requested months.`);
  }

  if (hasPurchaseTotal) {
    const partialPeriod = [dateRange.from, dateRange.to].some((value) => {
      if (!value) return false;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return false;
      const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      return date.getUTCDate() !== 1 && date.getUTCDate() !== monthEnd;
    });
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.PURCHASES,
      label: 'Purchases for selected period',
      value: purchaseTotal,
      unit: 'RWF',
      sourceService: 'MonthlyReportsService',
      sourceMethod: 'getVATReturn',
      sourceIds: purchaseSourceIds,
      permissions: REQUIRED_PERMISSIONS,
      metadata: {
        periods,
        ...(partialPeriod ? { caveat: 'Purchase totals are full calendar-month report values for a range that includes a partial month.' } : {}),
      },
    }));
  }

  const asOfPeriod = lastProcessedPeriod || end;
  try {
    const aging = await MonthlyReportsService.getAPAging(companyId, asOfPeriod.year, asOfPeriod.month);
    const totalPayables = Number(aging?.summary?.totalAP);
    if (Number.isFinite(totalPayables)) {
      facts.push(createFact({
        companyId,
        domain: AI_DOMAINS.PURCHASES,
        label: 'Total supplier outstanding balance',
        value: totalPayables,
        unit: 'RWF',
        sourceService: 'MonthlyReportsService',
        sourceMethod: 'getAPAging',
        sourceIds: [`ap_aging:${monthKey(asOfPeriod)}`],
        permissions: REQUIRED_PERMISSIONS,
        metadata: { asOfPeriod: monthKey(asOfPeriod) },
      }));
    }
  } catch (error) {
    warnings.push(`Payables aging report failed: ${error.message}`);
  }

  return { facts, warnings };
}

module.exports = {
  domain: AI_DOMAINS.PURCHASES,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};
