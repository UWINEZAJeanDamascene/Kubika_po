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

module.exports = {
  rulePackId: 'sales',
  evaluate(context) {
    return [
      ...evaluateSalesActivity(context),
    ];
  },
};
