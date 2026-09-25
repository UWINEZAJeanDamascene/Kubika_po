'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact } = require('../factFactory');
const MonthlyReportsService = require('../../../services/monthlyReportsService');

const REQUIRED_PERMISSIONS = ['tax.read', 'reports.read', 'finance.read'];
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

function includesPeriod(start, end, period) {
  const key = period.year * 12 + period.month;
  return key >= start.year * 12 + start.month && key <= end.year * 12 + end.month;
}

async function collect({ companyId, dateRange = {} }) {
  const now = new Date();
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const start = parsePeriod(dateRange.from) || parsePeriod(dateRange.to) || current;
  const end = parsePeriod(dateRange.to) || start;
  const monthlyFacts = [];
  const warnings = [];

  let period = { ...start };
  let count = 0;
  while (includesPeriod(start, end, period) && count < MAX_MONTHS) {
    const key = monthKey(period);
    try {
      const report = await MonthlyReportsService.getVATReturn(companyId, period.year, period.month);
      const outputVat = Number(report?.summary?.totalOutputVAT);
      const vatPayable = Number(report?.summary?.netVATPAYABLE);
      const sourceIds = [`vat_return:${key}`];
      for (const [label, value] of [
        [`VAT collected (${key})`, outputVat],
        [`VAT payable (${key})`, vatPayable],
      ]) {
        if (!Number.isFinite(value)) continue;
        monthlyFacts.push(createFact({
          companyId,
          domain: AI_DOMAINS.TAX,
          label,
          value,
          unit: 'RWF',
          sourceService: 'MonthlyReportsService',
          sourceMethod: 'getVATReturn',
          sourceIds,
          permissions: REQUIRED_PERMISSIONS,
          metadata: { period: key },
        }));
      }
    } catch (error) {
      warnings.push(`Tax report failed for ${key}: ${error.message}`);
    }

    count += 1;
    period.month += 1;
    if (period.month > 12) {
      period.month = 1;
      period.year += 1;
    }
  }

  if (includesPeriod(start, end, period)) {
    warnings.push(`Tax context is limited to the most recent ${MAX_MONTHS} requested months.`);
  }
  if (!monthlyFacts.length) return { facts: [], warnings };

  const isPartialCalendarMonth = (dateValue, boundary) => {
    if (!dateValue) return false;
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return false;
    if (boundary === 'from') return date.getUTCDate() !== 1;
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return date.getUTCDate() !== lastDay;
  };
  const partialPeriodCaveat = isPartialCalendarMonth(dateRange.from, 'from') || isPartialCalendarMonth(dateRange.to, 'to')
    ? 'Tax report values are full calendar-month totals; the requested range includes a partial month.'
    : null;

  const facts = [];
  for (const [aggregateLabel, monthlyLabel] of [
    ['VAT collected for selected period', 'VAT collected'],
    ['VAT payable for selected period', 'VAT payable'],
  ]) {
    const inputs = monthlyFacts.filter((fact) => fact.label.startsWith(`${monthlyLabel} (`));
    if (!inputs.length) continue;
    const value = inputs.reduce((total, fact) => total + Number(fact.value), 0);
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.TAX,
      label: aggregateLabel,
      value,
      unit: 'RWF',
      sourceService: 'MonthlyReportsService',
      sourceMethod: 'getVATReturn',
      sourceIds: inputs.flatMap((fact) => fact.sourceIds),
      permissions: REQUIRED_PERMISSIONS,
      metadata: {
        periods: inputs.map((fact) => fact.metadata.period),
        ...(partialPeriodCaveat ? { caveat: partialPeriodCaveat } : {}),
      },
    }));
  }

  return { facts: [...monthlyFacts, ...facts], warnings };
}

module.exports = {
  domain: AI_DOMAINS.TAX,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};
