'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { numberFact, objectFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function overdueFromAging(value) {
  if (!value || typeof value !== 'object') return 0;
  if (value.buckets && typeof value.buckets === 'object') {
    const buckets = value.buckets;
    return Number(buckets.days1_30 || 0) + Number(buckets.days31_60 || 0)
      + Number(buckets.days61_90 || 0) + Number(buckets.over90 || buckets.days90plus || 0);
  }
  return Number(value.overdue || value.overdueBalance || value.pastDue || value['90+'] || 0);
}

function evaluateOverdueReceivables(context) {
  const aging = objectFact(context, 'Receivables aging');
  const totalOutstanding = numberFact(context, 'Total client outstanding balance');
  const overdue = overdueFromAging(aging.value);

  if (!Number.isFinite(overdue) || overdue <= 0) return [];

  return [createFinding({
    companyId: context.companyId,
    ruleId: 'receivables.overdue_balance',
    domain: AI_DOMAINS.CUSTOMERS,
    title: 'Customer balances need collection follow-up',
    summary: `Receivables aging shows ${overdue} in overdue customer balances.`,
    severity: overdue > Number(totalOutstanding.value || 0) * 0.5
      ? FINDING_SEVERITIES.HIGH
      : FINDING_SEVERITIES.MEDIUM,
    evidenceFacts: [aging.fact, totalOutstanding.fact].filter(Boolean),
    recommendedNextStep: 'Prioritize payment reminders and review high-risk customer accounts before creating any collection action.',
    metadata: {
      overdueBalance: overdue,
      totalOutstandingBalance: totalOutstanding.value,
      ruleCertainty: 0.84,
    },
  })];
}

function evaluateSeverelyOverdueReceivables(context) {
  const aging = objectFact(context, 'Receivables aging');
  const buckets = aging.value?.buckets || {};
  const days90plus = Number(buckets.over90?.amount ?? buckets.over90 ?? buckets.days90plus?.amount ?? buckets.days90plus ?? aging.value?.days90plus ?? 0);
  if (!aging.fact || !Number.isFinite(days90plus) || days90plus <= 0) return [];
  return [createFinding({
    companyId: context.companyId,
    ruleId: 'receivables.severely_overdue_balance',
    domain: AI_DOMAINS.CUSTOMERS,
    title: 'Receivables include balances over 90 days overdue',
    summary: `The receivables aging report shows ${days90plus} in the 90+ day overdue bucket.`,
    severity: FINDING_SEVERITIES.HIGH,
    evidenceFacts: [aging.fact],
    recommendedNextStep: 'Review the affected customer accounts and confirm balances before planning collection follow-up.',
    metadata: { days90plus, ruleCertainty: 0.9, expectedEvidenceCount: 1 },
  })];
}

module.exports = {
  rulePackId: 'receivables',
  evaluate(context) {
    return [
      ...evaluateOverdueReceivables(context),
      ...evaluateSeverelyOverdueReceivables(context),
    ];
  },
};
