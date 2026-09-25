'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { objectFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function amountFromBucket(bucket) {
  return Number(bucket && typeof bucket === 'object' ? bucket.amount : bucket || 0);
}

function evaluatePayablesAging(context) {
  const aging = objectFact(context, 'Payables aging');
  if (!aging.fact || !aging.value || typeof aging.value !== 'object') return [];
  const buckets = aging.value.buckets || {};
  const overdue = amountFromBucket(buckets.days30) + amountFromBucket(buckets.days60)
    + amountFromBucket(buckets.days90) + amountFromBucket(buckets.days90plus || buckets.over90);
  const severelyOverdue = amountFromBucket(buckets.days90plus || buckets.over90);
  if (overdue <= 0) return [];
  return [createFinding({
    companyId: context.companyId,
    ruleId: 'payables.overdue_balance',
    domain: AI_DOMAINS.PURCHASES,
    title: severelyOverdue > 0 ? 'Supplier balances are over 90 days overdue' : 'Supplier balances are overdue',
    summary: severelyOverdue > 0
      ? `The payables aging report shows ${severelyOverdue} in the 90+ day overdue bucket.`
      : `The payables aging report shows ${overdue} in overdue supplier balances.`,
    severity: severelyOverdue > 0 ? FINDING_SEVERITIES.HIGH : FINDING_SEVERITIES.MEDIUM,
    evidenceFacts: [aging.fact],
    recommendedNextStep: 'Review supplier balances and due dates, then confirm payment priorities with the finance team.',
    metadata: { overdueBalance: overdue, days90plus: severelyOverdue, ruleCertainty: 0.88, expectedEvidenceCount: 1 },
  })];
}

module.exports = {
  rulePackId: 'payables',
  evaluate(context) {
    return evaluatePayablesAging(context);
  },
};
