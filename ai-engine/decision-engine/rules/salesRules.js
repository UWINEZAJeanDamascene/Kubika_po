'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function evaluateSalesActivity(context) {
  const invoiceCount = numberFact(context, 'Invoice count for selected period');
  const revenue = numberFact(context, 'Sales revenue for selected period');

  if (invoiceCount.value === 0) {
    return [createFinding({
      companyId: context.companyId,
      ruleId: 'sales.no_invoice_activity',
      domain: AI_DOMAINS.SALES,
      title: 'No invoice activity in selected period',
      summary: 'No invoices were found for the selected period.',
      severity: FINDING_SEVERITIES.LOW,
      evidenceFacts: [invoiceCount.fact].filter(Boolean),
      recommendedNextStep: 'Confirm the selected date range and review sales pipeline activity.',
      metadata: { ruleCertainty: 0.78 },
    })];
  }

  if (Number(invoiceCount.value || 0) > 0 && revenue.value === 0) {
    return [createFinding({
      companyId: context.companyId,
      ruleId: 'sales.invoice_without_revenue',
      domain: AI_DOMAINS.SALES,
      title: 'Invoices exist but revenue is zero',
      summary: `${invoiceCount.value} invoices were found, but selected-period revenue is zero.`,
      severity: FINDING_SEVERITIES.MEDIUM,
      evidenceFacts: [invoiceCount.fact, revenue.fact].filter(Boolean),
      recommendedNextStep: 'Check invoice totals, voided invoices, discounts, and reporting filters.',
      metadata: { invoiceCount: invoiceCount.value, revenue: revenue.value, ruleCertainty: 0.82 },
    })];
  }

  return [];
}

function evaluateSalesTrend(context) {
  const timeline = context.facts.find((fact) => String(fact.label || '').toLowerCase() === 'sales timeline for selected period');
  const periods = Array.isArray(timeline?.value) ? timeline.value : [];
  if (periods.length < 2) return [];
  const ordered = periods
    .map((period) => ({ period, revenue: Number(period.revenue) }))
    .filter((entry) => Number.isFinite(entry.revenue))
    .sort((a, b) => String(a.period.period).localeCompare(String(b.period.period)));
  if (ordered.length < 2) return [];
  const previous = ordered[ordered.length - 2];
  const latest = ordered[ordered.length - 1];
  if (previous.revenue <= 0 || latest.revenue >= previous.revenue) return [];
  const changePercent = Number((((latest.revenue - previous.revenue) / previous.revenue) * 100).toFixed(2));
  if (changePercent > -20) return [];
  const historicalChanges = ordered.slice(1).map((entry, index) => ({
    previous: ordered[index].revenue,
    current: entry.revenue,
  })).filter((change) => change.previous > 0);
  const historicalConsistency = historicalChanges.length > 1
    ? historicalChanges.filter((change) => change.current < change.previous).length / historicalChanges.length
    : 0.65;

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'sales.material_revenue_decline',
    domain: AI_DOMAINS.SALES,
    title: 'Sales revenue declined materially',
    summary: `Sales revenue declined ${Math.abs(changePercent)}% from ${previous.period.period} to ${latest.period.period}.`,
    severity: changePercent <= -50 ? FINDING_SEVERITIES.HIGH : FINDING_SEVERITIES.MEDIUM,
    evidenceFacts: [timeline],
    recommendedNextStep: 'Compare invoice volume, average sale value, and customer activity across the two periods.',
    metadata: {
      previousPeriod: previous.period.period,
      previousRevenue: previous.revenue,
      latestPeriod: latest.period.period,
      latestRevenue: latest.revenue,
      changePercent,
      ruleCertainty: 0.75,
      expectedEvidenceCount: 1,
      historicalConsistency,
    },
  })];
}

module.exports = {
  rulePackId: 'sales',
  evaluate(context) {
    return [
      ...evaluateSalesActivity(context),
      ...evaluateSalesTrend(context),
    ];
  },
};
