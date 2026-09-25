'use strict';

const { AI_DOMAINS } = require('../../shared/interfaces');
const { createFact } = require('../factFactory');
const MonthlyReportsService = require('../../../services/monthlyReportsService');

const REQUIRED_PERMISSIONS = ['payroll.read', 'employees.read', 'reports.read'];

function parsePeriod(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  return Number.isNaN(date.getTime())
    ? null
    : { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function collect({ companyId, dateRange = {} }) {
  const now = new Date();
  const currentPeriod = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const startPeriod = parsePeriod(dateRange.from) || parsePeriod(dateRange.to) || currentPeriod;
  const endPeriod = parsePeriod(dateRange.to) || startPeriod;
  const facts = [];
  const warnings = [];
  const periodTotals = new Map();
  const periodSourceIds = [];
  const periods = [];
  let { year, month } = startPeriod;
  let monthsCollected = 0;

  while ((year < endPeriod.year || (year === endPeriod.year && month <= endPeriod.month)) && monthsCollected < 24) {
    const period = { year, month };
    try {
      const report = await MonthlyReportsService.getPayrollSummary(companyId, year, month);
      const summary = report && report.summary;
      periodSourceIds.push(`monthly_payroll_summary:${monthKey(period)}`);
      periods.push(monthKey(period));
      if (!summary) {
        warnings.push(`Payroll summary returned no totals for ${monthKey(period)}.`);
      } else {
        const sourceIds = [`monthly_payroll_summary:${monthKey(period)}`];
        const totals = [
          ['Payroll gross pay', summary.totalGrossPay, 'RWF'],
          ['Payroll net pay', summary.totalNetPay, 'RWF'],
          ['Payroll employer cost', summary.totalEmployerCost, 'RWF'],
          ['Payroll PAYE withheld', summary.totalPAYE, 'RWF'],
          ['Payroll employee count', summary.totalEmployees, 'count'],
        ];

        for (const [label, value, unit] of totals) {
          const numericValue = Number(value);
          if (!Number.isFinite(numericValue)) continue;
          periodTotals.set(label, (periodTotals.get(label) || 0) + numericValue);
          facts.push(createFact({
            companyId,
            domain: AI_DOMAINS.PAYROLL,
            label: `${label} (${monthKey(period)})`,
            value: numericValue,
            unit,
            sourceService: 'MonthlyReportsService',
            sourceMethod: 'getPayrollSummary',
            sourceIds,
            permissions: REQUIRED_PERMISSIONS,
            metadata: { period: monthKey(period) },
          }));
        }
      }
    } catch (error) {
      warnings.push(`Payroll summary failed for ${monthKey(period)}: ${error.message}`);
    }

    monthsCollected += 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  if (year < endPeriod.year || (year === endPeriod.year && month <= endPeriod.month)) {
    warnings.push('Payroll context is limited to the most recent 24 requested months.');
  }

  for (const [label, value] of periodTotals) {
    const partialPeriod = [dateRange.from, dateRange.to].some((dateValue) => {
      if (!dateValue) return false;
      const date = new Date(dateValue);
      if (Number.isNaN(date.getTime())) return false;
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      return date.getUTCDate() !== 1 && date.getUTCDate() !== lastDay;
    });
    facts.push(createFact({
      companyId,
      domain: AI_DOMAINS.PAYROLL,
      label: `${label} for selected period`,
      value,
      unit: label === 'Payroll employee count' ? 'count' : 'RWF',
      sourceService: 'MonthlyReportsService',
      sourceMethod: 'getPayrollSummary',
      sourceIds: periodSourceIds,
      permissions: REQUIRED_PERMISSIONS,
      metadata: {
        periods,
        ...(partialPeriod ? { caveat: 'Payroll report values are full calendar-month totals for a range that includes a partial month.' } : {}),
      },
    }));
  }

  return {
    facts,
    warnings,
  };
}

module.exports = {
  domain: AI_DOMAINS.PAYROLL,
  requiredPermissions: REQUIRED_PERMISSIONS,
  collect,
};
