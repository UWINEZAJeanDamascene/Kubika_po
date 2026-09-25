'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact, objectFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function evaluateVatEstimate(context) {
  const vat = numberFact(context, 'VAT collected estimate');
  if (vat.value == null || vat.value <= 0) return [];

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'tax.vat_collected_estimate',
    domain: AI_DOMAINS.TAX,
    title: 'VAT collected estimate is available',
    summary: `Estimated VAT collected for the selected period is ${vat.value}.`,
    severity: FINDING_SEVERITIES.INFO,
    evidenceFacts: [vat.fact].filter(Boolean),
    recommendedNextStep: 'Reconcile this estimate with filed tax reports before submission or payment.',
    metadata: {
      vatCollectedEstimate: vat.value,
      ruleCertainty: 0.72,
    },
  })];
}

function daysUntilUtc(dateValue, now = new Date()) {
  const due = new Date(dateValue);
  if (Number.isNaN(due.getTime())) return null;
  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((dueDay - today) / (24 * 60 * 60 * 1000));
}

function evaluateTaxDeadlines(context, now = new Date()) {
  const calendar = objectFact(context, 'Tax compliance calendar');
  if (!calendar.fact || !Array.isArray(calendar.value)) return [];
  const actionable = calendar.value
    .map((entry) => ({ ...entry, daysUntilDue: daysUntilUtc(entry.dueDate, now) }))
    .filter((entry) => entry.daysUntilDue != null
      && !/^(filed|paid|completed|closed|cancelled)$/i.test(String(entry.status || ''))
      && entry.daysUntilDue <= 7)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  if (!actionable.length) return [];
  const deadline = actionable[0];
  const overdue = deadline.daysUntilDue < 0;
  const date = new Date(deadline.dueDate).toISOString().slice(0, 10);
  return [createFinding({
    companyId: context.companyId,
    ruleId: overdue ? 'tax.compliance_deadline_overdue' : 'tax.compliance_deadline_approaching',
    domain: AI_DOMAINS.TAX,
    title: overdue ? 'A recorded tax compliance deadline is overdue' : 'A recorded tax compliance deadline is approaching',
    summary: overdue
      ? `${deadline.taxType} deadline recorded for ${date} is ${Math.abs(deadline.daysUntilDue)} day(s) overdue.`
      : `${deadline.taxType} deadline recorded for ${date} is due within ${deadline.daysUntilDue} day(s).`,
    severity: overdue ? FINDING_SEVERITIES.CRITICAL : FINDING_SEVERITIES.HIGH,
    evidenceFacts: [calendar.fact],
    recommendedNextStep: 'Verify the filing or payment status against the official tax account and the company calendar.',
    metadata: {
      taxType: deadline.taxType,
      dueDate: date,
      daysUntilDue: deadline.daysUntilDue,
      calendarEntryId: deadline.id,
      ruleCertainty: 0.92,
      expectedEvidenceCount: 1,
    },
  })];
}

module.exports = {
  rulePackId: 'tax',
  evaluate(context) {
    return [
      ...evaluateVatEstimate(context),
      ...evaluateTaxDeadlines(context),
    ];
  },
};
